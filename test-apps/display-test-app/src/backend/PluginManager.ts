/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
import * as fs from "fs";
import * as path from "path";
import { Logger } from "@itwin/core-bentley";
import { RpcInterfaceDefinition, RpcManager, RpcRegistry } from "@itwin/core-common";

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
 * 已注册的插件信息
 */
interface RegisteredPlugin {
  config: PluginConfig;
  loadedModules: Map<string, any>; // 模块路径 -> 模块实例
  rpcInterfaces: Map<string, RpcInterfaceDefinition>; // 接口名 -> 接口类
}

/**
 * 插件管理器
 * 负责插件的动态加载、注册、卸载和管理
 */
export class PluginManager {
  private _registeredPlugins = new Map<string, RegisteredPlugin>();
  private _basePluginsPath: string;

  constructor() {
    this._basePluginsPath = path.join(__dirname, "..", "..", "plugins");
  }

  /**
   * 加载所有插件
   */
  public loadPlugins(): void {
    const pluginListPath = path.join(this._basePluginsPath, "pluginlist.json");

    if (!fs.existsSync(pluginListPath)) {
      Logger.logInfo("PluginManager", "插件列表文件未找到", () => ({ pluginListPath }));
      return;
    }

    try {
      const pluginListContent = fs.readFileSync(pluginListPath, "utf-8");
      const pluginList = JSON.parse(pluginListContent);

      // 首先卸载所有已禁用的插件
      for (const [pluginName, _plugin] of this._registeredPlugins) {
        const config = pluginList.plugins.find((p: PluginConfig) => p.name === pluginName);
        if (!config || !config.enabled) {
          this.unregisterPlugin(pluginName);
        }
      }

      // 然后加载或更新启用的插件
      for (const plugin of pluginList.plugins) {
        if (plugin.enabled) {
          this.registerPlugin(plugin);
        }
      }

      Logger.logInfo("PluginManager", "插件加载完成", () => ({
        loadedCount: this._registeredPlugins.size
      }));
    } catch (error) {
      Logger.logError("PluginManager", "加载插件时出错", () => ({ error }));
    }
  }

  /**
   * 注册单个插件
   */
  private registerPlugin(pluginConfig: PluginConfig): void {
    if (this._registeredPlugins.has(pluginConfig.name)) {
      Logger.logInfo("PluginManager", "插件已注册，重新加载", () => ({ pluginName: pluginConfig.name }));
      this.unregisterPlugin(pluginConfig.name);
    }

    try {
      const pluginPath = this.resolvePluginPath(pluginConfig);
      if (!pluginPath) {
        Logger.logError("PluginManager", "无法解析插件路径", () => ({ pluginName: pluginConfig.name }));
        return;
      }

      const registeredPlugin: RegisteredPlugin = {
        config: pluginConfig,
        loadedModules: new Map(),
        rpcInterfaces: new Map()
      };

      // 注册所有RPC接口
      for (const rpcInterface of pluginConfig.rpcInterfaces) {
        this.registerRpcInterface(registeredPlugin, rpcInterface);
      }

      // 初始化插件
      this.initializePlugin(registeredPlugin);

      this._registeredPlugins.set(pluginConfig.name, registeredPlugin);
      Logger.logInfo("PluginManager", "插件注册成功", () => ({ pluginName: pluginConfig.name }));

    } catch (error) {
      Logger.logError("PluginManager", "注册插件失败", () => ({
        pluginName: pluginConfig.name,
        error
      }));
    }
  }

  /**
   * 解析插件路径
   */
  private resolvePluginPath(pluginConfig: PluginConfig): string | null {
    // 如果配置中有路径，使用配置的路径
    if (pluginConfig.path) {
      const fullPath = path.join(this._basePluginsPath, pluginConfig.path);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }

    // 否则尝试默认路径：plugins/插件名/
    const defaultPath = path.join(this._basePluginsPath, pluginConfig.name);
    if (fs.existsSync(defaultPath)) {
      return defaultPath;
    }

    return null;
  }

  /**
   * 注册RPC接口
   */
  private registerRpcInterface(plugin: RegisteredPlugin, rpcConfig: { interface: string; implementation: string }): void {
    try {
      // 尝试加载接口类
      const interfaceClass = this.loadRpcClass(plugin, rpcConfig.interface, "interface");
      if (!interfaceClass) {
        Logger.logError("PluginManager", "加载RPC接口类失败", () => ({ interface: rpcConfig.interface }));
        return;
      }

      // 尝试加载实现类
      const implementationClass = this.loadRpcClass(plugin, rpcConfig.implementation, "implementation");
      if (!implementationClass) {
        Logger.logError("PluginManager", "加载RPC实现类失败", () => ({ implementation: rpcConfig.implementation }));
        return;
      }

      // 先初始化RPC接口
      RpcManager.initializeInterface(interfaceClass);

      // 然后注册RPC接口和实现
      RpcManager.registerImpl(interfaceClass, implementationClass);
      plugin.rpcInterfaces.set(rpcConfig.interface, interfaceClass);

      const isRegistered = RpcRegistry.instance.definitionClasses.has(interfaceClass.interfaceName);
      if (!isRegistered) {
        Logger.logError("PluginManager", "RPC接口初始化后仍未被注册", () => ({ interface: rpcConfig.interface }));
        return;
      }
      Logger.logInfo("PluginManager", "RPC接口注册成功", () => ({
        interface: rpcConfig.interface,
        implementation: rpcConfig.implementation
      }));

    } catch (error) {
      Logger.logError("PluginManager", "注册RPC接口失败", () => ({
        interface: rpcConfig.interface,
        implementation: rpcConfig.implementation,
        error
      }));
    }
  }

  /**
   * 加载RPC类
   */
  private loadRpcClass(plugin: RegisteredPlugin, className: string, type: "interface" | "implementation"): any {
    // 首先尝试从已加载的模块中查找
    for (const [modulePath, module] of plugin.loadedModules) {
      if (module[className]) {
        return module[className];
      }
    }

    // 尝试从插件路径下的不同位置加载
    const possiblePaths = this.getPossibleModulePaths(plugin.config, className, type);

    for (const modulePath of possiblePaths) {
      try {
        if (fs.existsSync(modulePath)) {
          // 清除require缓存以确保重新加载
          delete require.cache[require.resolve(modulePath)];
          const module = require(modulePath);
          plugin.loadedModules.set(modulePath, module);

          if (module[className]) {
            return module[className];
          }
        }
      } catch {
        // 继续尝试下一个路径
        continue;
      }
    }

    Logger.logWarning("PluginManager", `无法找到RPC${type === "interface" ? "接口" : "实现"}类`, () => ({
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
   * 初始化插件
   */
  private initializePlugin(plugin: RegisteredPlugin): void {
    const initializationConfig = plugin.config.initialization;
    if (!initializationConfig) {
      return; // 没有初始化配置，跳过
    }

    try {
      // 加载初始化模块
      const modulePath = this.resolveInitializationModulePath(plugin.config, initializationConfig.module);
      if (!modulePath) {
        Logger.logError("PluginManager", "无法解析初始化模块路径", () => ({
          module: initializationConfig.module,
          pluginName: plugin.config.name
        }));
        return;
      }

      // 清除缓存并加载模块
      delete require.cache[require.resolve(modulePath)];
      const module = require(modulePath);
      plugin.loadedModules.set(modulePath, module);

      // 获取初始化类
      const initializationClass = module[initializationConfig.class];
      if (!initializationClass) {
        Logger.logError("PluginManager", "无法找到初始化类", () => ({
          class: initializationConfig.class,
          module: initializationConfig.module,
          pluginName: plugin.config.name
        }));
        return;
      }

      // 调用初始化方法
      if (typeof initializationClass[initializationConfig.method] === 'function') {
        initializationClass[initializationConfig.method]();
        Logger.logInfo("PluginManager", "插件初始化成功", () => ({
          pluginName: plugin.config.name,
          class: initializationConfig.class,
          method: initializationConfig.method
        }));
      } else {
        Logger.logError("PluginManager", "初始化方法不是函数", () => ({
          class: initializationConfig.class,
          method: initializationConfig.method,
          pluginName: plugin.config.name
        }));
      }
    } catch (error) {
      Logger.logError("PluginManager", "插件初始化失败", () => ({
        pluginName: plugin.config.name,
        error
      }));
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

      // 特定于GeologyPlugin的路径（保持向后兼容）
      // path.join(pluginPath, "geologybim-backend", "lib", "cjs", "SZEWGeologyBIMBackend.js"),
      // path.join(pluginPath, "geologybim-backend", "lib", "cjs", "geologybim-backend.js"),
      // path.join(pluginPath, "geologybim-backend", "lib", "esm", "SZEWGeologyBIMBackend.js"),
      // path.join(pluginPath, "geologybim-backend", "lib", "esm", "geologybim-backend.js"),
      // path.join(pluginPath, "geologybim-backend", "SZEWGeologyBIMBackend.js"),
      // path.join(pluginPath, "geologybim-backend", "geologybim-backend.js")
    ];

    // 返回第一个存在的路径
    for (const possiblePath of possiblePaths) {
      if (fs.existsSync(possiblePath)) {
        return possiblePath;
      }
    }

    // 如果以上路径都不匹配，尝试遍历插件目录查找匹配的文件
    try {
      const findModuleRecursively = (dir: string, targetModule: string): string | null => {
        if (!fs.existsSync(dir)) return null;

        const items = fs.readdirSync(dir);
        for (const item of items) {
          const itemPath = path.join(dir, item);
          const stat = fs.statSync(itemPath);

          if (stat.isDirectory()) {
            const result = findModuleRecursively(itemPath, targetModule);
            if (result) return result;
          } else if (item === targetModule ||
            item.endsWith(targetModule) ||
            item === `${targetModule}.js`) {
            return itemPath;
          }
        }
        return null;
      };

      // 从插件根目录开始递归查找
      const moduleName = path.basename(modulePath);
      const recursiveResult = findModuleRecursively(pluginPath, moduleName);
      if (recursiveResult) {
        return recursiveResult;
      }
    } catch (error) {
      Logger.logWarning("PluginManager", "递归查找模块时发生错误", () => ({
        pluginName: pluginConfig.name,
        modulePath,
        error
      }));
    }

    return null;
  }

  /**
   * 取消注册插件
   */
  private unregisterPlugin(pluginName: string): void {
    const plugin = this._registeredPlugins.get(pluginName);
    if (!plugin) return;

    try {
      // 注销所有RPC接口
      for (const interfaceDefinition of plugin.rpcInterfaces.values()) {
        try {
          RpcRegistry.instance.terminateRpcInterface(interfaceDefinition);
          Logger.logInfo("PluginManager", "RPC接口注销成功", () => ({
            interfaceName: interfaceDefinition.interfaceName,
            pluginName
          }));
        } catch (error) {
          Logger.logError("PluginManager", "注销RPC接口失败", () => ({
            interfaceName: interfaceDefinition.interfaceName,
            pluginName,
            error
          }));
        }
      }

      // 清除已加载的模块缓存
      for (const modulePath of plugin.loadedModules.keys()) {
        try {
          delete require.cache[require.resolve(modulePath)];
        } catch {
          // 忽略清除缓存时的错误
        }
      }

      this._registeredPlugins.delete(pluginName);
      Logger.logInfo("PluginManager", "插件取消注册", () => ({ pluginName }));

    } catch (error) {
      Logger.logError("PluginManager", "取消注册插件失败", () => ({
        pluginName,
        error
      }));
    }
  }

  /**
   * 验证RPC接口注册
   */
  public validateRpcRegistrations(): { [key: string]: boolean } {
    const validationResults: { [key: string]: boolean } = {};

    for (const [pluginName, plugin] of this._registeredPlugins) {
      for (const rpcInterface of plugin.config.rpcInterfaces) {
        const isValid = plugin.rpcInterfaces.has(rpcInterface.interface);
        validationResults[`${pluginName}.${rpcInterface.interface}`] = isValid;

        if (!isValid) {
          Logger.logWarning("PluginManager", "RPC接口验证失败", () => ({
            pluginName,
            interface: rpcInterface.interface
          }));
        }
      }
    }

    Logger.logInfo("PluginManager", "RPC接口验证完成", () => ({ validationResults }));
    return validationResults;
  }

  /**
   * 获取已注册的插件列表
   */
  public getRegisteredPlugins(): PluginConfig[] {
    return Array.from(this._registeredPlugins.values()).map(p => p.config);
  }

  /**
   * 获取已注册的RPC接口列表
   */
  public getRegisteredRpcInterfaces(): string[] {
    const interfaces: string[] = [];
    for (const plugin of this._registeredPlugins.values()) {
      for (const interfaceName of plugin.rpcInterfaces.keys()) {
        interfaces.push(interfaceName);
      }
    }
    return interfaces;
  }

  /**
   * 重新加载所有插件
   */
  public reloadPlugins(): void {
    Logger.logInfo("PluginManager", "重新加载所有插件");
    this.loadPlugins();
  }

  /**
   * 启动文件监视器
   */
  public startFileWatcher(): void {
    const pluginListPath = path.join(this._basePluginsPath, "pluginlist.json");
    const pluginsDir = path.dirname(pluginListPath);

    if (!fs.existsSync(pluginsDir)) {
      Logger.logInfo("PluginManager", "插件目录未找到", () => ({ pluginsDir }));
      return;
    }

    fs.watch(pluginsDir, (_eventType, filename) => {
      if (filename === "pluginlist.json") {
        Logger.logInfo("PluginManager", "插件列表已更改，重新加载插件...");
        this.loadPlugins();
      }
    });

    Logger.logInfo("PluginManager", "插件文件监视器已启动");
  }
}

// 导出单例实例
export const pluginManager = new PluginManager();
