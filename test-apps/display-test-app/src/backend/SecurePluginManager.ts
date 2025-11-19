/*---------------------------------------------------------------------------------------------
* Copyright (c) SZEWEC Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
import * as fs from "fs";
import * as path from "path";
import { isMainThread, parentPort, Worker, workerData } from "worker_threads";
import * as vm from "vm";
import { Logger } from "@itwin/core-bentley";

/**
 * 插件配置接口
 */
export interface PluginConfig {
  name: string;
  enabled: boolean;
  rpcInterfaces: {
    interface: string;
    implementation: string;
  }[];
  path?: string; // 插件路径，相对于plugins目录
  initialization?: {
    class: string;
    method: string;
    module: string;
  };
}

/**
 * Worker消息类型
 */
export interface WorkerMessage {
  type: "load" | "execute" | "unload" | "result" | "error" | "rpcCall" | "rpcResponse";
  pluginName: string;
  data?: any;
  requestId?: string;
}


/**
 * Worker中的插件实例
 */
interface WorkerPluginInstance {
  config: PluginConfig;
  sandbox: vm.Context;
  loadedModules: Map<string, any>;
  rpcInterfaces: Map<string, any>;
}

/**
 * Worker线程中的插件管理器
 */
class WorkerPluginManager {
  private _plugins = new Map<string, WorkerPluginInstance>();
  private _basePluginsPath: string;
  private _pluginListPath: string;
  private _fileWatcher: fs.FSWatcher | null = null;

  constructor() {
    this._basePluginsPath = workerData.basePluginsPath;
    this._pluginListPath = path.join(this._basePluginsPath, "pluginlist.json");
    this.initial();
  }

  public initial(): void {
    this.setupMessageHandler();
    this.autoLoadPlugins();
    this.startFileWatcher();
  }

  /**
   * 设置消息处理器
   */
  private setupMessageHandler(): void {
    if (!parentPort) return;

    parentPort.on("message", async (message: WorkerMessage) => {
      try {
        switch (message.type) {
          case "load":
            await this.loadPlugin(message.pluginName, message.data);
            break;
          case "execute":
            await this.executePluginMethod(message.pluginName, message.data);
            break;
          case "unload":
            this.unloadPlugin(message.pluginName);
            break;
          default:
            this.sendMessage({
              type: "error",
              pluginName: message.pluginName,
              data: `未知的消息类型: ${message.type}`
            });
        }
      } catch (error) {
        this.sendMessage({
          type: "error",
          pluginName: message.pluginName,
          data: error instanceof Error ? error.message : String(error)
        });
      }
    });
  }

  /**
   * 发送消息到主线程
   */
  private sendMessage(message: WorkerMessage): void {
    if (parentPort) {
      parentPort.postMessage(message);
    }
  }

  /**
   * 在沙箱中加载插件
   */
  private async loadPlugin(pluginName: string, config: PluginConfig): Promise<void> {
    try {
      // 解析插件路径
      const pluginPath = this.resolvePluginPath(config);
      if (!pluginPath) {
        throw new Error(`无法解析插件路径: ${pluginName}`);
      }

      // 创建安全的沙箱环境，传入插件路径用于node_modules查找
      const sandbox = this.createSecureSandbox(pluginPath);

      const pluginInstance: WorkerPluginInstance = {
        config,
        sandbox,
        loadedModules: new Map(),
        rpcInterfaces: new Map()
      };

      // 在沙箱中加载插件模块
      await this.loadPluginModules(pluginInstance, pluginPath);

      this._plugins.set(pluginName, pluginInstance);

      this.sendMessage({
        type: "result",
        pluginName,
        data: { success: true, message: "插件加载成功" }
      });
    } catch (error) {
      this.sendMessage({
        type: "error",
        pluginName,
        data: `加载插件失败: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  /**
   * 创建安全沙箱环境
   */
  private createSecureSandbox(_pluginPath?: string): vm.Context {
    // 基础安全全局对象
    const secureGlobal = {
      console: {
        log: (...args: any[]) => {
          // 重定向控制台输出到日志系统
          Logger.logInfo("PluginSandbox", "插件日志", () => ({ args }));
        },
        error: (...args: any[]) => {
          Logger.logError("PluginSandbox", "插件错误", () => ({ args }));
        },
        warn: (...args: any[]) => {
          Logger.logWarning("PluginSandbox", "插件警告", () => ({ args }));
        }
      },
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      JSON,
      Math,
      Date,
      // 限制访问其他全局对象
      process: {
        env: {}, // 空环境变量
        cwd: () => "/sandbox", // 虚拟工作目录
        platform: "sandbox",
        version: process.version
      },
      Buffer,
      // 增强的require函数，支持核心模块、插件内部模块和相对路径
      require: (id: string) => {
        // 首先尝试在插件node_modules中查找
        if (_pluginPath) {
          const pluginNodeModulesPath = path.join(_pluginPath, "node_modules");
          if (fs.existsSync(pluginNodeModulesPath)) {
            const modulePath = path.join(pluginNodeModulesPath, id);
            if (fs.existsSync(modulePath)) {
              try {
                // 读取package.json获取入口文件
                const packageJsonPath = path.join(modulePath, "package.json");
                let entryFile = "index.js";

                if (fs.existsSync(packageJsonPath)) {
                  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
                  entryFile = packageJson.main || entryFile;
                }

                const entryPath = path.join(modulePath, entryFile);
                if (fs.existsSync(entryPath)) {
                  const content = fs.readFileSync(entryPath, "utf-8");
                  const exports: Record<string, any> = {};

                  // 创建支持插件node_modules的增强require函数
                  const pluginNodeModulesRequire = (moduleId: string) => {
                    // 如果是相对路径，在当前模块目录内解析
                    if (moduleId.startsWith('.')) {
                      const baseDir = path.dirname(entryPath);
                      const resolvedPath = path.resolve(baseDir, moduleId);

                      // 确保解析后的路径在插件目录内
                      if (!resolvedPath.startsWith(_pluginPath)) {
                        throw new Error(`试图访问插件外部路径: ${moduleId}`);
                      }

                      // 尝试多种可能的文件路径
                      const moduleTryPaths = [
                        resolvedPath,
                        `${resolvedPath}.js`,
                        `${resolvedPath}.ts`,
                        path.join(resolvedPath, 'index.js'),
                        path.join(resolvedPath, 'index.ts')
                      ];

                      for (const tryPath of moduleTryPaths) {
                        if (fs.existsSync(tryPath)) {
                          const moduleContent = fs.readFileSync(tryPath, "utf-8");
                          const moduleExports: Record<string, any> = {};
                          const moduleScript = new vm.Script(moduleContent);
                          const moduleContext = vm.createContext({
                            ...secureGlobal,
                            module: { exports: moduleExports },
                            exports: moduleExports,
                            require: pluginNodeModulesRequire
                          });
                          moduleScript.runInContext(moduleContext);
                          return moduleExports;
                        }
                      }
                      throw new Error(`无法找到相对路径模块: ${moduleId}`);
                    }

                    // 对于非相对路径，尝试在当前插件的node_modules中查找
                    const nestedModulePath = path.join(pluginNodeModulesPath, moduleId);
                    if (fs.existsSync(nestedModulePath)) {
                      const nestedPackageJsonPath = path.join(nestedModulePath, "package.json");
                      let nestedEntryFile = "index.js";

                      if (fs.existsSync(nestedPackageJsonPath)) {
                        const nestedPackageJson = JSON.parse(fs.readFileSync(nestedPackageJsonPath, "utf-8"));
                        nestedEntryFile = nestedPackageJson.main || nestedEntryFile;
                      }

                      const nestedEntryPath = path.join(nestedModulePath, nestedEntryFile);
                      if (fs.existsSync(nestedEntryPath)) {
                        const nestedContent = fs.readFileSync(nestedEntryPath, "utf-8");
                        const nestedExports: Record<string, any> = {};
                        const nestedScript = new vm.Script(nestedContent);
                        const nestedContext = vm.createContext({
                          ...secureGlobal,
                          module: { exports: nestedExports },
                          exports: nestedExports,
                          require: pluginNodeModulesRequire
                        });
                        nestedScript.runInContext(nestedContext);
                        return nestedExports;
                      }
                    }

                    // 如果当前插件node_modules中找不到，使用原有的require逻辑
                    return secureGlobal.require(moduleId);
                  };

                  const script = new vm.Script(content);
                  const context = vm.createContext({
                    ...secureGlobal,
                    module: { exports },
                    exports,
                    require: pluginNodeModulesRequire
                  });
                  script.runInContext(context);
                  return exports;
                }
              } catch (error) {
                Logger.logWarning("PluginSandbox", `在插件node_modules中加载模块失败`, () => ({
                  module: id,
                  pluginPath: _pluginPath,
                  error: error instanceof Error ? error.message : String(error)
                }));
                // 继续尝试其他加载方式
              }
            }
          }
        }
        // 允许的核心模块列表
        const allowedModules = [
          "@itwin/core-common",
          "@itwin/core-bentley",
          "@itwin/core-backend",
          "@itwin/core-frontend",
          "@itwin/core-geometry",
          "@bentley/imodeljs-i18n",
          "@bentley/imodeljs-markup",
          "@bentley/geometry-core",
          "@bentley/ecschema-metadata",
          "@bentley/ecschema-locaters",
          "@bentley/ecschema-editing",
          "@bentley/ecsql-common",
          "@bentley/linear-referencing-common",
          "@bentley/linear-referencing-backend",
          "@bentley/physical-material-backend",
          "@bentley/presentation-common",
          "@bentley/presentation-backend",
          "@bentley/presentation-frontend",
          "@bentley/analytical-backend",
          "@bentley/editor-common",
          "@bentley/editor-backend",
          "@bentley/editor-frontend",
          "@bentley/imodel-components-react",
          "@bentley/appui-abstract",
          "@bentley/frontend-devtools",
          "@bentley/frontend-tiles",
          "@bentley/hypermodeling-frontend",
          "@bentley/map-layers-auth",
          "@bentley/map-layers-formats",
          "@bentley/webgl-compatibility",
          "@bentley/cesium-renderer",
          "@bentley/express-server",
          "@bentley/core-orbitgt",
          "@bentley/core-markup",
          "@bentley/core-mobile",
          "@bentley/core-quantity",
          "fs",
          "path",
          "util",
          "events",
          "stream",
          "buffer",
          "crypto",
          "url",
          "querystring",
          "http",
          "https",
          "zlib",
          "os",
          "child_process",
          "cluster",
          "dgram",
          "dns",
          "net",
          "tls",
          "tty",
          "vm",
          "worker_threads"
        ];

        // 检查是否在允许的模块列表中
        if (allowedModules.includes(id)) {
          try {
            // 使用Worker线程的require加载核心模块
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            return require(id);
          } catch (error) {
            Logger.logWarning("PluginSandbox", `加载核心模块失败`, () => ({
              module: id,
              error: error instanceof Error ? error.message : String(error)
            }));
            throw new Error(`无法加载核心模块: ${id}`);
          }
        }

        // 插件内部模块 - 允许加载插件目录下的模块
        const pluginInternalModules = [
          "@szew/geologybim-common",
          "@szew/geologybim-backend",
          "@szew/geologybim-frontend",
          "@szew/corebim-backend"
        ];

        if (pluginInternalModules.includes(id)) {
          try {
            // 解析插件内部模块路径
            const pluginBasePath = this._basePluginsPath;
            let modulePath: string | null = null;

            // 根据模块名映射到实际的插件目录
            if (id === "@szew/geologybim-common") {
              modulePath = path.join(pluginBasePath, "GeologyPlugin", "geologybim-common");
            } else if (id === "@szew/geologybim-backend") {
              modulePath = path.join(pluginBasePath, "GeologyPlugin", "geologybim-backend");
            } else if (id === "@szew/geologybim-frontend") {
              modulePath = path.join(pluginBasePath, "GeologyPlugin", "geologybim-frontend");
            } else if (id === "@szew/corebim-backend") {
              modulePath = path.join(pluginBasePath, "GeologyPlugin", "corebim-backend");
            }

            if (modulePath && fs.existsSync(modulePath)) {
              // 尝试加载模块的主文件
              const possibleEntries = [
                path.join(modulePath, "lib", "cjs", "index.js"),
                path.join(modulePath, "lib", "cjs", `${path.basename(modulePath)}.js`),
                path.join(modulePath, "lib", "esm", "index.js"),
                path.join(modulePath, "lib", "esm", `${path.basename(modulePath)}.js`),
                path.join(modulePath, "index.js"),
                path.join(modulePath, `${path.basename(modulePath)}.js`)
              ];

              for (const entry of possibleEntries) {
                if (fs.existsSync(entry)) {
                  const content = fs.readFileSync(entry, "utf-8");
                  const exports: Record<string, any> = {};

                  // 创建支持相对路径的增强require函数
                  const enhancedRequire = (moduleId: string) => {
                    // 如果是相对路径，在插件目录内解析
                    if (moduleId.startsWith('.')) {
                      const baseDir = path.dirname(entry);
                      const resolvedPath = path.resolve(baseDir, moduleId);

                      // 确保解析后的路径在插件目录内
                      if (!resolvedPath.startsWith(pluginBasePath)) {
                        throw new Error(`试图访问插件外部路径: ${moduleId}`);
                      }

                      // 尝试多种可能的文件路径
                      const moduleTryPaths = [
                        resolvedPath,
                        `${resolvedPath}.js`,
                        `${resolvedPath}.ts`,
                        path.join(resolvedPath, 'index.js'),
                        path.join(resolvedPath, 'index.ts')
                      ];

                      for (const tryPath of moduleTryPaths) {
                        if (fs.existsSync(tryPath)) {
                          const moduleContent = fs.readFileSync(tryPath, "utf-8");
                          const moduleExports: Record<string, any> = {};
                          const moduleScript = new vm.Script(moduleContent);
                          const moduleContext = vm.createContext({
                            ...secureGlobal,
                            module: { exports: moduleExports },
                            exports: moduleExports,
                            require: enhancedRequire
                          });
                          moduleScript.runInContext(moduleContext);
                          return moduleExports;
                        }
                      }
                      throw new Error(`无法找到相对路径模块: ${moduleId}`);
                    }

                    // 对于非相对路径，使用原有的require逻辑
                    return secureGlobal.require(moduleId);
                  };

                  const script = new vm.Script(content);
                  const context = vm.createContext({
                    ...secureGlobal,
                    module: { exports },
                    exports,
                    require: enhancedRequire
                  });
                  script.runInContext(context);
                  return exports;
                }
              }

              throw new Error(`无法找到插件内部模块的入口文件: ${id}`);
            } else {
              throw new Error(`插件内部模块路径不存在: ${modulePath}`);
            }
          } catch (error) {
            Logger.logWarning("PluginSandbox", `加载插件内部模块失败`, () => ({
              module: id,
              error: error instanceof Error ? error.message : String(error)
            }));
            throw new Error(`无法加载插件内部模块: ${id}`);
          }
        }

        // 相对路径模块 - 在插件内部模块加载中已经处理
        if (id.startsWith('.')) {
          throw new Error(`沙箱环境中不允许加载相对路径模块: ${id}`);
        }

        throw new Error(`沙箱环境中不允许加载外部模块: ${id}`);
      },
      // eslint-disable-next-line @typescript-eslint/naming-convention
      __dirname: "/sandbox",
      // eslint-disable-next-line @typescript-eslint/naming-convention
      __filename: "/sandbox/module.js",
      module: { exports: {} },
      exports: {}
    };

    return vm.createContext(secureGlobal);
  }

  /**
   * 解析插件路径
   */
  private resolvePluginPath(pluginConfig: PluginConfig): string | null {
    if (pluginConfig.path) {
      const fullPath = path.join(this._basePluginsPath, pluginConfig.path);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }

    const defaultPath = path.join(this._basePluginsPath, pluginConfig.name);
    if (fs.existsSync(defaultPath)) {
      return defaultPath;
    }

    return null;
  }

  /**
   * 在沙箱中加载插件模块
   */
  private async loadPluginModules(plugin: WorkerPluginInstance, pluginPath: string): Promise<void> {
    try {
      // 注册所有RPC接口，参照PluginManager.registerRpcInterface的实现
      for (const rpcInterface of plugin.config.rpcInterfaces) {
        await this.registerRpcInterfaceInSandbox(plugin, rpcInterface);
      }

      // 初始化插件
      await this.initializePluginInSandbox(plugin);

      Logger.logInfo("WorkerPluginManager", "插件模块加载完成", () => ({
        pluginName: plugin.config.name,
        rpcInterfaces: plugin.config.rpcInterfaces.length,
        pluginPath
      }));

    } catch (error) {
      throw new Error(`模块加载失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 在沙箱中注册RPC接口
   */
  private async registerRpcInterfaceInSandbox(plugin: WorkerPluginInstance, rpcConfig: { interface: string; implementation: string }): Promise<void> {
    try {
      // 加载接口类
      const interfaceClass = await this.loadRpcClassInSandbox(plugin, rpcConfig.interface, "interface");
      if (!interfaceClass) {
        Logger.logError("WorkerPluginManager", "加载RPC接口类失败", () => ({ interface: rpcConfig.interface }));
        return;
      }

      // 加载实现类
      const implementationClass = await this.loadRpcClassInSandbox(plugin, rpcConfig.implementation, "implementation");
      if (!implementationClass) {
        Logger.logError("WorkerPluginManager", "加载RPC实现类失败", () => ({ implementation: rpcConfig.implementation }));
        return;
      }

      // 在沙箱中注册RPC接口
      plugin.rpcInterfaces.set(rpcConfig.interface, interfaceClass);

      Logger.logInfo("WorkerPluginManager", "RPC接口在沙箱中注册成功", () => ({
        interface: rpcConfig.interface,
        implementation: rpcConfig.implementation,
        pluginName: plugin.config.name
      }));

    } catch (error) {
      Logger.logError("WorkerPluginManager", "在沙箱中注册RPC接口失败", () => ({
        interface: rpcConfig.interface,
        implementation: rpcConfig.implementation,
        pluginName: plugin.config.name,
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  }

  /**
   * 在沙箱中加载RPC类
   */
  private async loadRpcClassInSandbox(plugin: WorkerPluginInstance, className: string, type: "interface" | "implementation"): Promise<any> {
    // 首先尝试从已加载的模块中查找
    for (const [_modulePath, module] of plugin.loadedModules) {
      if ((module as Record<string, any>)[className]) {
        return (module as Record<string, any>)[className];
      }
    }

    // 尝试从插件路径下的不同位置加载模块代码
    const possiblePaths = this.getPossibleModulePaths(plugin.config, className, type);

    for (const _modulePath of possiblePaths) {
      try {
        if (fs.existsSync(_modulePath)) {
          // 读取模块文件内容
          const moduleContent = fs.readFileSync(_modulePath, "utf-8");

          // 在沙箱中执行模块代码
          const moduleExports: Record<string, any> = {};
          const moduleScript = new vm.Script(moduleContent);
          const context = vm.createContext({
            ...plugin.sandbox,
            module: { exports: moduleExports },
            exports: moduleExports,
            require: (id: string) => {
              // 增强的require模拟，支持相对路径和文件扩展名
              if (id.startsWith('.')) {
                const baseDir = path.dirname(_modulePath);
                const resolvedBase = path.resolve(baseDir, id);

                // 尝试多种可能的文件路径
                const moduleTryPaths = [
                  resolvedBase,
                  `${resolvedBase}.js`,
                  `${resolvedBase}.ts`,
                  path.join(resolvedBase, 'index.js'),
                  path.join(resolvedBase, 'index.ts')
                ];

                for (const tryPath of moduleTryPaths) {
                  if (fs.existsSync(tryPath)) {
                    const content = fs.readFileSync(tryPath, "utf-8");
                    const exports: Record<string, any> = {};
                    const requireScript = new vm.Script(content);
                    requireScript.runInContext(vm.createContext({
                      ...plugin.sandbox,
                      module: { exports },
                      exports
                    }));
                    return exports;
                  }
                }

                // 如果所有路径都不存在，尝试查找目录中的package.json
                if (fs.existsSync(resolvedBase) && fs.statSync(resolvedBase).isDirectory()) {
                  const packageJsonPath = path.join(resolvedBase, 'package.json');
                  if (fs.existsSync(packageJsonPath)) {
                    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
                    const mainFile = packageJson.main || 'index.js';
                    const mainPath = path.join(resolvedBase, mainFile);
                    if (fs.existsSync(mainPath)) {
                      const content = fs.readFileSync(mainPath, "utf-8");
                      const exports: Record<string, any> = {};
                      const requireScript = new vm.Script(content);
                      requireScript.runInContext(vm.createContext({
                        ...plugin.sandbox,
                        module: { exports },
                        exports
                      }));
                      return exports;
                    }
                  }
                }
              }
              throw new Error(`无法解析模块: ${id}`);
            }
          });

          moduleScript.runInContext(context);

          // 将模块添加到已加载模块映射
          plugin.loadedModules.set(_modulePath, moduleExports);

          if (moduleExports[className]) {
            return moduleExports[className];
          }
        }
      } catch (error) {
        // 继续尝试下一个路径
        Logger.logWarning("WorkerPluginManager", `加载模块路径失败`, () => ({
          modulePath: _modulePath,
          className,
          type,
          error: error instanceof Error ? error.message : String(error)
        }));
        continue;
      }
    }

    Logger.logWarning("WorkerPluginManager", `无法找到RPC${type === "interface" ? "接口" : "实现"}类`, () => ({
      className,
      type,
      pluginName: plugin.config.name
    }));

    return null;
  }

  /**
   * 获取可能的模块路径
   */
  private getPossibleModulePaths(pluginConfig: PluginConfig, _className: string, type: "interface" | "implementation"): string[] {
    const pluginPath = this.resolvePluginPath(pluginConfig);
    if (!pluginPath) return [];

    const paths: string[] = [];

    // 根据类型确定可能的模块位置
    if (type === "interface") {
      // 接口通常在common模块中
      paths.push(
        path.join(pluginPath, "geologybim-common", "lib", "cjs", "geologybim-common.js"),
        path.join(pluginPath, "geologybim-common", "lib", "cjs", "SZEWGeologyBIMCommon.js"),
        path.join(pluginPath, "geologybim-common", "lib", "esm", "geologybim-common.js"),
        path.join(pluginPath, "geologybim-common", "lib", "esm", "SZEWGeologyBIMCommon.js")
      );
    } else {
      // 实现在backend模块中
      paths.push(
        path.join(pluginPath, "geologybim-backend", "lib", "cjs", "geologybim-backend.js"),
        path.join(pluginPath, "geologybim-backend", "lib", "cjs", "SZEWGeologyBIMBackend.js"),
        path.join(pluginPath, "geologybim-backend", "lib", "esm", "geologybim-backend.js"),
        path.join(pluginPath, "geologybim-backend", "lib", "esm", "SZEWGeologyBIMBackend.js")
      );
    }

    return paths;
  }

  /**
   * 在沙箱中初始化插件
   */
  private async initializePluginInSandbox(plugin: WorkerPluginInstance): Promise<void> {
    const initializationConfig = plugin.config.initialization;
    if (!initializationConfig) {
      return; // 没有初始化配置，跳过
    }

    try {
      // 加载初始化模块
      const modulePath = this.resolveInitializationModulePath(plugin.config, initializationConfig.module);
      if (!modulePath) {
        Logger.logError("WorkerPluginManager", "无法解析初始化模块路径", () => ({
          module: initializationConfig.module,
          pluginName: plugin.config.name
        }));
        return;
      }

      // 加载初始化模块
      const moduleContent = fs.readFileSync(modulePath, "utf-8");
      const moduleExports: Record<string, any> = {};
      const script = new vm.Script(moduleContent);
      const context = vm.createContext({
        ...plugin.sandbox,
        module: { exports: moduleExports },
        exports: moduleExports
      });

      script.runInContext(context);
      plugin.loadedModules.set(modulePath, moduleExports);

      // 获取初始化类
      const initializationClass = moduleExports[initializationConfig.class];
      if (!initializationClass) {
        Logger.logError("WorkerPluginManager", "无法找到初始化类", () => ({
          class: initializationConfig.class,
          module: initializationConfig.module,
          pluginName: plugin.config.name
        }));
        return;
      }

      // 调用初始化方法
      if (typeof initializationClass[initializationConfig.method] === 'function') {
        // 在沙箱中执行初始化方法
        const initScript = new vm.Script(`
          (function() {
            try {
              ${initializationConfig.class}.${initializationConfig.method}();
              return { success: true };
            } catch (error) {
              return { success: false, error: error.message };
            }
          })()
        `);

        const result = initScript.runInContext(plugin.sandbox);

        if (result.success) {
          Logger.logInfo("WorkerPluginManager", "插件初始化成功", () => ({
            pluginName: plugin.config.name,
            class: initializationConfig.class,
            method: initializationConfig.method
          }));
        } else {
          throw new Error(result.error);
        }
      } else {
        Logger.logError("WorkerPluginManager", "初始化方法不是函数", () => ({
          class: initializationConfig.class,
          method: initializationConfig.method,
          pluginName: plugin.config.name
        }));
      }
    } catch (error) {
      Logger.logError("WorkerPluginManager", "插件初始化失败", () => ({
        pluginName: plugin.config.name,
        error: error instanceof Error ? error.message : String(error)
      }));
      throw error;
    }
  }

  /**
   * 解析初始化模块路径
   */
  private resolveInitializationModulePath(pluginConfig: PluginConfig, modulePath: string): string | null {
    const pluginPath = this.resolvePluginPath(pluginConfig);
    if (!pluginPath) return null;

    // 生成所有可能的模块路径
    const possiblePaths = [
      // 尝试配置的原始路径
      path.join(pluginPath, modulePath),

      // 如果原始路径不存在，则尝试其他常见路径格式
      // 通用格式 - 直接在插件根目录下查找
      path.join(pluginPath, `${pluginConfig.name}.js`),
      path.join(pluginPath, `${pluginConfig.name}.ts`),

      // 通用格式 - lib/cjs目录下
      path.join(pluginPath, "lib", "cjs", `${pluginConfig.name}.js`),

      // 通用格式 - lib/esm目录下
      path.join(pluginPath, "lib", "esm", `${pluginConfig.name}.js`),

      // 通用格式 - dist目录下
      path.join(pluginPath, "dist", `${pluginConfig.name}.js`),

      // 如果配置了初始化模块但没有指定目录，尝试常见的子模块路径
      path.join(pluginPath, "backend", modulePath),
      path.join(pluginPath, "server", modulePath)
    ];

    // 返回第一个存在的路径
    for (const possiblePath of possiblePaths) {
      if (fs.existsSync(possiblePath)) {
        return possiblePath;
      }
    }

    return null;
  }

  /**
   * 执行插件方法
   */
  private async executePluginMethod(pluginName: string, data: any): Promise<void> {
    const plugin = this._plugins.get(pluginName);
    if (!plugin) {
      throw new Error(`插件未加载: ${pluginName}`);
    }

    try {
      const { method, args } = data;

      // 在沙箱中执行方法
      const result = await this.executeInSandbox(plugin.sandbox, method, args);

      this.sendMessage({
        type: "result",
        pluginName,
        data: { success: true, result }
      });
    } catch (error) {
      this.sendMessage({
        type: "error",
        pluginName,
        data: `执行方法失败: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  /**
   * 在沙箱中执行代码
   */
  private async executeInSandbox(sandbox: vm.Context, method: string, args: any[]): Promise<any> {
    const script = `
      (function() {
        try {
          if (typeof ${method} !== 'function') {
            throw new Error('方法不存在或不是函数: ' + ${JSON.stringify(method)});
          }
          return ${method}.apply(globalThis, ${JSON.stringify(args)});
        } catch (error) {
          return { __error: true, message: error.message, stack: error.stack };
        }
      })()
    `;

    const result = vm.runInContext(script, sandbox);

    if (result && result.__error) {
      throw new Error(`沙箱执行错误: ${result.message}`);
    }

    return result;
  }

  /**
   * 启动文件监视器，监听pluginlist.json变化
   */
  private startFileWatcher(): void {
    const pluginsDir = path.dirname(this._pluginListPath);

    if (!fs.existsSync(pluginsDir)) {
      Logger.logInfo("WorkerPluginManager", "插件目录未找到", () => ({ pluginsDir }));
      return;
    }

    try {
      this._fileWatcher = fs.watch(pluginsDir, (_eventType, filename) => {
        if (filename === "pluginlist.json") {
          Logger.logInfo("WorkerPluginManager", "检测到pluginlist.json变化，重新加载插件");
          this.reloadPlugins();
        }
      });

      Logger.logInfo("WorkerPluginManager", "插件文件监视器已启动", () => ({ pluginsDir }));
    } catch (error) {
      Logger.logError("WorkerPluginManager", "启动文件监视器失败", () => ({
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  }

  /**
   * 重新加载所有插件，根据enable状态进行热加载和卸载
   */
  private reloadPlugins(): void {
    try {
      if (!fs.existsSync(this._pluginListPath)) {
        Logger.logInfo("WorkerPluginManager", "插件列表文件未找到", () => ({ pluginListPath: this._pluginListPath }));
        return;
      }

      const pluginListContent = fs.readFileSync(this._pluginListPath, "utf-8");
      const pluginList = JSON.parse(pluginListContent);

      // 首先卸载所有已禁用的插件
      for (const [pluginName, _plugin] of this._plugins) {
        const config = pluginList.plugins.find((p: PluginConfig) => p.name === pluginName);
        if (!config || !config.enabled) {
          Logger.logInfo("WorkerPluginManager", "卸载已禁用的插件", () => ({ pluginName }));
          this.unloadPlugin(pluginName);
        }
      }

      // 然后加载或更新启用的插件
      for (const plugin of pluginList.plugins) {
        if (plugin.enabled) {
          if (this._plugins.has(plugin.name)) {
            // 插件已存在，重新加载以更新
            Logger.logInfo("WorkerPluginManager", "重新加载插件", () => ({ pluginName: plugin.name }));
            this.unloadPlugin(plugin.name);
          }
          // 加载插件
          void this.loadPlugin(plugin.name, plugin).catch((error) => {
            Logger.logError("WorkerPluginManager", "加载插件失败", () => ({
              pluginName: plugin.name,
              error: error instanceof Error ? error.message : String(error)
            }));
          });
        }
      }

      Logger.logInfo("WorkerPluginManager", "插件重新加载完成", () => ({
        totalPlugins: pluginList.plugins.length,
        enabledPlugins: pluginList.plugins.filter((p: PluginConfig) => p.enabled).length,
        runningPlugins: this._plugins.size
      }));

    } catch (error) {
      Logger.logError("WorkerPluginManager", "重新加载插件失败", () => ({
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  }

  /**
   * 自动从pluginlist.json加载所有启用的插件
   */
  private autoLoadPlugins(): void {
    this.reloadPlugins();
  }

  /**
   * 卸载插件
   */
  private unloadPlugin(pluginName: string): void {
    this._plugins.delete(pluginName);

    this.sendMessage({
      type: "result",
      pluginName,
      data: { success: true, message: "插件卸载成功" }
    });
  }

  /**
   * 清理资源
   */
  public cleanup(): void {
    if (this._fileWatcher) {
      this._fileWatcher.close();
      this._fileWatcher = null;
      Logger.logInfo("WorkerPluginManager", "文件监视器已关闭");
    }

    // 清理所有插件
    for (const pluginName of this._plugins.keys()) {
      this.unloadPlugin(pluginName);
    }

    Logger.logInfo("WorkerPluginManager", "Worker插件管理器已清理");
  }
}

// Worker线程入口点
if (!isMainThread) {
  new WorkerPluginManager();
}

/**
 * 安全插件管理器（主线程）
 */
export class SecurePluginManager {
  private _workers = new Map<string, Worker>();
  private _basePluginsPath: string;
  private _messageHandlers = new Map<string, (data: any) => void>();

  constructor() {
    this._basePluginsPath = path.join(__dirname, "..", "..", "plugins");
  }

  /**
   * 加载插件到Worker线程
   */
  public async loadPlugin(pluginConfig: PluginConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this._workers.has(pluginConfig.name)) {
        reject(new Error(`插件已在运行: ${pluginConfig.name}`));
        return;
      }

      const worker = new Worker(__filename, {
        workerData: {
          basePluginsPath: this._basePluginsPath
        }
      });

      // 设置消息处理器
      worker.on("message", (message: WorkerMessage) => {
        this.handleWorkerMessage(pluginConfig.name, message);

        if (message.type === "result" && message.data?.success) {
          resolve();
        } else if (message.type === "error") {
          reject(new Error(message.data));
        }
      });

      worker.on("error", (error) => {
        reject(new Error(`Worker错误: ${error.message}`));
      });

      worker.on("exit", (code) => {
        if (code !== 0) {
          Logger.logError("SecurePluginManager", "Worker异常退出", () => ({
            pluginName: pluginConfig.name,
            exitCode: code
          }));
        }
        this._workers.delete(pluginConfig.name);
      });

      this._workers.set(pluginConfig.name, worker);

      // 发送加载消息
      worker.postMessage({
        type: "load",
        pluginName: pluginConfig.name,
        data: pluginConfig
      } as WorkerMessage);
    });
  }

  /**
   * 执行插件方法
   */
  public async executePluginMethod(pluginName: string, method: string, args: any[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      const worker = this._workers.get(pluginName);
      if (!worker) {
        reject(new Error(`插件未加载: ${pluginName}`));
        return;
      }

      const requestId = this.generateRequestId();

      // 注册响应处理器
      this._messageHandlers.set(requestId, (data: any) => {
        if (data.success) {
          resolve(data.result);
        } else {
          reject(new Error(data.error || "执行失败"));
        }
      });

      worker.postMessage({
        type: "execute",
        pluginName,
        data: { method, args },
        requestId
      } as WorkerMessage);
    });
  }

  /**
   * 处理Worker消息
   */
  private handleWorkerMessage(pluginName: string, message: WorkerMessage): void {
    switch (message.type) {
      case "result":
        if (message.requestId && this._messageHandlers.has(message.requestId)) {
          const handler = this._messageHandlers.get(message.requestId)!;
          handler(message.data);
          this._messageHandlers.delete(message.requestId);
        }
        break;
      case "error":
        Logger.logError("SecurePluginManager", "Worker错误", () => ({
          pluginName,
          error: message.data
        }));
        break;
      default:
        Logger.logInfo("SecurePluginManager", "收到Worker消息", () => ({
          pluginName,
          type: message.type
        }));
    }
  }

  /**
   * 生成请求ID
   */
  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * 卸载插件
   */
  public async unloadPlugin(pluginName: string): Promise<void> {
    const worker = this._workers.get(pluginName);
    if (!worker) {
      throw new Error(`插件未加载: ${pluginName}`);
    }

    return new Promise((resolve) => {
      worker.postMessage({
        type: "unload",
        pluginName
      } as WorkerMessage);

      // 等待Worker完成清理后终止
      void setTimeout(() => {
        worker.terminate();
        this._workers.delete(pluginName);
        resolve();
      }, 100);
    });
  }

  /**
   * 获取运行的插件列表
   */
  public getRunningPlugins(): string[] {
    return Array.from(this._workers.keys());
  }

  /**
   * 清理所有Worker
   */
  public async cleanup(): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const pluginName of this._workers.keys()) {
      promises.push(this.unloadPlugin(pluginName));
    }

    await Promise.all(promises);
  }
}

// 导出单例实例
export const securePluginManager = new SecurePluginManager();
