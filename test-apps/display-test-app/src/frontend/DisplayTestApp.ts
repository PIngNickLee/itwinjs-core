/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
import { Logger, LogLevel, ProcessDetector } from "@itwin/core-bentley";
import { RpcConfiguration, RpcManager, RpcRegistry } from "@itwin/core-common";
import {
  GpuMemoryLimit,
  IModelApp, IModelConnection, RenderSystem, TileAdmin,
  ViewManager,
} from "@itwin/core-frontend";
import { initializeFrontendTiles } from "@itwin/frontend-tiles";
import { WebGLExtensionName } from "@itwin/webgl-compatibility";
import { DtaBooleanConfiguration, DtaConfiguration, DtaNumberConfiguration, DtaStringConfiguration, getConfig } from "../common/DtaConfiguration";
import { DtaRpcInterface } from "../common/DtaRpcInterface";
import { DisplayTestApp } from "./App";
import { MobileMessenger } from "./FileOpen";
import { openIModel, OpenIModelProps } from "./openIModel";
import { signIn } from "./signIn";
import { Surface } from "./Surface";
import { setTitle } from "./Title";
import { showStatus } from "./Utils";
import { Dock } from "./Window";
import { createCesiumRenderSystem, createCesiumViewManager } from "@itwin/cesium-renderer";

const configuration: DtaConfiguration = {};

/**
 * Get the value for a string configuration param.
 * @param key The parameter name of the parameter to get.
 * @returns The value of the string configuration param.
 */
export function getConfigurationString(key: keyof DtaStringConfiguration) {
  return (configuration as DtaStringConfiguration)[key];
}

/**
 * Get the value for a boolean configuration param.
 * @param key The parameter name of the parameter to get.
 * @returns The value of the boolean configuration param, or false if the param is undefined.
 */
export function getConfigurationBoolean(key: keyof DtaBooleanConfiguration): boolean {
  return (configuration as DtaBooleanConfiguration)[key] ?? false;
}

/**
 * Get the value for a numeric configuration param.
 * @param key The parameter name of the parameter to get.
 * @returns The value of the numeric configuration param.
 */
export function getConfigurationNumber(key: keyof DtaNumberConfiguration) {
  return (configuration as DtaNumberConfiguration)[key];
}

const getFrontendConfig = async (useRPC = false) => {
  if (ProcessDetector.isMobileAppFrontend) {
    if (window) {
      const urlParams = new URLSearchParams(window.location.hash);
      urlParams.forEach((val, key) => {
        (configuration as any)[key] = val;
      });
    }
  } else {
    const config: DtaConfiguration = useRPC ? await DtaRpcInterface.getClient().getEnvConfig() : getConfig();
    Object.assign(configuration, config);
  }

  // Overriding the configuration generally requires setting environment variables, rebuilding the app, and restarting the app from scratch -
  // and sometimes that doesn't even work.
  // If you want to quickly adjust aspects of the configuration on the frontend, you can instead add your overrides below and just hot-reload the app in the browser/electron.
  // Obviously, don't commit such changes.
  const configurationOverrides: DtaConfiguration = {
    /* For example:
    iModelName: "d:\\bim\\Constructions.bim",
    disableInstancing: true,
    */
  };
  Object.assign(configuration, configurationOverrides);

  console.log("Configuration", configuration); // eslint-disable-line no-console
};

async function openFile(props: OpenIModelProps): Promise<IModelConnection> {
  configuration.standalone = true;
  const iModelConnection = await openIModel(props);
  configuration.iModelName = iModelConnection.name;
  return iModelConnection;
}

function setConfigurationResults(): [renderSystemOptions: RenderSystem.Options | RenderSystem, tileAdminProps: TileAdmin.Props, viewManager?: ViewManager] {
  let renderSystemOptions: RenderSystem.Options | RenderSystem;
  let viewManager: ViewManager | undefined;

  if (true === configuration.useCesium) {
    renderSystemOptions = createCesiumRenderSystem();
    viewManager = createCesiumViewManager();
  } else
    renderSystemOptions = {
      disabledExtensions: configuration.disabledExtensions as WebGLExtensionName[],
      preserveShaderSourceCode: true === configuration.preserveShaderSourceCode,
      logarithmicDepthBuffer: false !== configuration.logarithmicZBuffer,
      dpiAwareViewports: false !== configuration.dpiAwareViewports,
      devicePixelRatioOverride: configuration.devicePixelRatioOverride,
      dpiAwareLOD: true === configuration.dpiAwareLOD,
      useWebGL2: false !== configuration.useWebGL2,
      planProjections: true,
      errorOnMissingUniform: false !== configuration.errorOnMissingUniform,
      debugShaders: true === configuration.debugShaders,
      antialiasSamples: configuration.antialiasSamples,
    };

  const tileAdminProps: TileAdmin.Props = {
    retryInterval: 50,
    enableInstancing: true,
    enableIndexedEdges: true !== configuration.disableIndexedEdges,
  };

  if (configuration.disableInstancing)
    tileAdminProps.enableInstancing = false;

  if (false === configuration.enableImprovedElision)
    tileAdminProps.enableImprovedElision = false;

  if (configuration.ignoreAreaPatterns)
    tileAdminProps.ignoreAreaPatterns = true;

  if (false === configuration.useProjectExtents)
    tileAdminProps.useProjectExtents = false;

  if (configuration.cacheTileMetadata)
    tileAdminProps.cacheTileMetadata = true;

  if (configuration.disableMagnification)
    tileAdminProps.disableMagnification = true;

  if (configuration.disableBRepCache)
    tileAdminProps.optimizeBRepProcessing = false;

  if (undefined !== configuration.gpuMemoryLimit)
    tileAdminProps.gpuMemoryLimits = configuration.gpuMemoryLimit as GpuMemoryLimit;

  if (true === configuration.noImdlWorker)
    tileAdminProps.decodeImdlInWorker = false;

  tileAdminProps.enableExternalTextures = (configuration.enableExternalTextures !== false);
  tileAdminProps.enableFrontendScheduleScripts = (configuration.enableFrontendScheduleScripts !== false);
  tileAdminProps.tileTreeExpirationTime = configuration.tileTreeExpirationSeconds;
  tileAdminProps.tileExpirationTime = configuration.tileExpirationSeconds;
  tileAdminProps.maximumLevelsToSkip = configuration.maxTilesToSkip;
  tileAdminProps.alwaysRequestEdges = true === configuration.alwaysLoadEdges;
  tileAdminProps.minimumSpatialTolerance = configuration.minimumSpatialTolerance;
  tileAdminProps.alwaysSubdivideIncompleteTiles = true === configuration.alwaysSubdivideIncompleteTiles;
  tileAdminProps.cesiumIonKey = configuration.cesiumIonKey;
  tileAdminProps.disablePolyfaceDecimation = true === configuration.disablePolyfaceDecimation;

  return [renderSystemOptions, tileAdminProps, viewManager];
}

// simple function to extract file name, without path or extension, on Windows or Linux
function getFileName(path: string): string {
  let strs = path.split("/");
  let str = strs[strs.length - 1];
  strs = str.split("\\");
  str = strs[strs.length - 1];
  const ndx = str.lastIndexOf(".");
  if (ndx > 0) // allow files starting with .
    str = str.substring(0, ndx);
  return str;
}

// simple function to extract the file extension, including '.', on Windows or Linux
function getFileExt(path: string): string {
  let strs = path.split("/");
  let str = strs[strs.length - 1];
  strs = str.split("\\");
  str = strs[strs.length - 1];
  const ndx = str.lastIndexOf(".");
  if (ndx > 0) // allow files starting with .
    str = str.substring(ndx);
  else
    str = "";
  return str;
}

// main entry point.
const dtaFrontendMain = async () => {
  RpcConfiguration.developmentMode = true; // needed for snapshots in web apps
  RpcConfiguration.disableRoutingValidation = true;

  // retrieve, set, and output the global configuration variable
  await getFrontendConfig();

  // Start the app. (This tries to fetch a number of localization json files from the origin.)
  let tileAdminProps: TileAdmin.Props;
  let renderSystemOptions: RenderSystem.Options | RenderSystem;
  let viewManager: ViewManager | undefined;
  // eslint-disable-next-line prefer-const
  [renderSystemOptions, tileAdminProps, viewManager] = setConfigurationResults();
  await DisplayTestApp.startup(configuration, renderSystemOptions, tileAdminProps, viewManager);
  if (false !== configuration.enableDiagnostics)
    IModelApp.renderSystem.debugControl?.enableDiagnostics(undefined);

  if (!configuration.standalone && !configuration.customOrchestratorUri) {
    alert("Standalone iModel required. Set IMJS_STANDALONE_FILENAME in environment");
    return;
  }

  Logger.initializeToConsole();
  Logger.setLevelDefault(LogLevel.Warning);
  Logger.setLevel("core-frontend.Render", LogLevel.Error);

  // We can call RPC at this point (after startup), so if not mobile, call RPC and get true env from backend,
  // then shutdown frontend, init vars again based on possibly changed configuration, then startup again
  // (All that to workaround the fact that we can't call RPC before we start to get the true env first.)
  if (!ProcessDetector.isMobileAppFrontend) {
    Object.assign(configuration, await getFrontendConfig(true));
    // console.log("New Front End Configuration from backend:", JSON.stringify(configuration)); // eslint-disable-line no-console
    await IModelApp.shutdown();
    [renderSystemOptions, tileAdminProps] = setConfigurationResults();
    await DisplayTestApp.startup(configuration, renderSystemOptions, tileAdminProps, viewManager);
    if (false !== configuration.enableDiagnostics)
      IModelApp.renderSystem.debugControl?.enableDiagnostics(undefined);

    if (!configuration.standalone && !configuration.customOrchestratorUri) {
      alert("Standalone iModel required. Set IMJS_STANDALONE_FILENAME in environment");
      return;
    }
  }

  // this needs to execute after all DisplayTestApp.startup executions so that env var will be current
  if (configuration.frontendTilesUrlTemplate) {
    initializeFrontendTiles({
      enableEdges: true,
      computeSpatialTilesetBaseUrl: async (iModel) => {
        let urlStr = configuration.frontendTilesUrlTemplate!.replace("{iModel.key}", iModel.key);
        urlStr = urlStr.replace("{iModel.filename}", getFileName(iModel.key));
        urlStr = urlStr.replace("{iModel.extension}", getFileExt(iModel.key));
        const url = new URL(urlStr);
        const tilesetUrl = new URL("tileset.json", url);
        tilesetUrl.search = url.search;

        // Check if a tileset has been published for this iModel.
        try {
          console.log(`Checking for tileset at ${tilesetUrl.toString()}`); // eslint-disable-line no-console
          const response = await fetch(tilesetUrl);
          await response.json();
          return url;
        } catch {
          // No tileset available.
          return undefined;
        }
      },
    });
  }

  const uiReady = displayUi(); // Get the browser started loading our html page and the svgs that it references but DON'T WAIT

  try {
    if (!configuration.standalone || configuration.signInForStandalone) {
      while (!await signIn()) {
        alert("please sign in");
      }
    }

    let iModel: IModelConnection | undefined;
    const iModelName = configuration.iModelName;
    const origStandalone = configuration.standalone;
    if (undefined !== iModelName) {
      try {
        const writable = configuration.openReadWrite ?? false;
        iModel = await openFile({ fileName: iModelName, writable });
        if (ProcessDetector.isMobileAppFrontend) {
          // attempt to send message to mobile that the model was opened
          MobileMessenger.postMessage("modelOpened", iModelName);
        }
        setTitle(iModel);
      } catch (error) {
        configuration.standalone = origStandalone;
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        console.error(`Error opening snapshot iModel: ${error}`); // eslint-disable-line no-console
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        alert(`Error opening snapshot iModel: ${error}`);
      }
    } else {
      try {
        const iModelId = configuration.iModelId;
        const iTwinId = configuration.iTwinId;
        if (undefined !== iModelId && undefined !== iTwinId) {
          const writable = configuration.openReadWrite ?? false;
          iModel = await openFile({ iModelId, iTwinId, writable });
          setTitle(iModel);
        }
      } catch (error) {
        configuration.standalone = origStandalone;
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        console.error(`Error getting hub iModel: ${error}`); // eslint-disable-line no-console
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        alert(`Error getting hub iModel: ${error}`);
      }
    }

    await uiReady; // Now wait for the HTML UI to finish loading.
    await initView(iModel);

    if (configuration.startupMacro)
      await IModelApp.tools.parseAndRun(`dta macro ${configuration.startupMacro}`);
  } catch (reason) {
    alert(reason);
    return;
  }
};

async function documentLoaded(): Promise<void> {
  const readyState = /^complete$/;
  if (readyState.test(document.readyState))
    return;

  return new Promise<void>((resolve) => {
    const listener = () => {
      if (readyState.test(document.readyState)) {
        document.removeEventListener("readystatechange", listener);
        resolve();
      }
    };

    document.addEventListener("readystatechange", listener);
    listener();
  });
}

async function initView(iModel: IModelConnection | undefined) {
  // open the specified view
  showStatus("opening View", configuration.viewName);

  const fileSelector = undefined !== configuration.standalonePath ? {
    directory: configuration.standalonePath,
    input: document.getElementById("browserFileSelector") as HTMLInputElement,
  } : undefined;

  DisplayTestApp.surface = new Surface(configuration, document.getElementById("app-surface")!, document.getElementById("toolBar")!, fileSelector, configuration.openReadWrite ?? false);

  // We need layout to complete so that the div we want to stick our viewport into has non-zero dimensions.
  // Consistently reproducible for some folks, not others...
  await documentLoaded();

  if (undefined !== iModel) {
    const viewer = await DisplayTestApp.surface.createViewer({
      iModel,
      defaultViewName: configuration.viewName,
      disableEdges: true === configuration.disableEdges,
      configuration
    });

    viewer.dock(Dock.Full);
  }

  showStatus("View Ready");
  hideSpinner();
}

// Set up the HTML UI elements and wire them to our functions
async function displayUi() {
  return new Promise<void>(async (resolve) => {
    showSpinner();

    // 创建地质RPC测试悬浮面板
    createGeologyRPCPanel();

    resolve();
  });
}

// 创建地质RPC测试悬浮面板
function createGeologyRPCPanel() {
  // 创建主容器
  const panel = document.createElement("div");
  panel.id = "geology-rpc-panel";
  panel.className = "floating-panel";

  // 面板样式
  Object.assign(panel.style, {
    position: "fixed",
    top: "20px",
    right: "20px",
    width: "350px",
    height: "500px",
    backgroundColor: "white",
    border: "2px solid #007bff",
    borderRadius: "8px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
    zIndex: "1000",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    resize: "both",
    minWidth: "300px",
    minHeight: "400px"
  });

  // 创建标题栏
  const header = document.createElement("div");
  header.className = "panel-header";
  Object.assign(header.style, {
    padding: "10px",
    backgroundColor: "#007bff",
    color: "white",
    fontWeight: "bold",
    cursor: "move",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    userSelect: "none"
  });
  header.innerHTML = `
    <span>地质RPC测试面板</span>
    <button id="close-panel" style="background: none; border: none; color: white; cursor: pointer; font-size: 16px;">×</button>
  `;

  // 创建内容区域
  const content = document.createElement("div");
  content.className = "panel-content";
  Object.assign(content.style, {
    flex: "1",
    padding: "10px",
    overflowY: "auto",
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
    gap: "8px",
    alignContent: "start"
  });

  // 创建RPC接口按钮
  const rpcMethods = [
    { name: "GetAllTerrainInfo", params: ["_tokenProps"] },
    { name: "SweepLinestringToTerrain", params: ["_linestring", "_sweepDirt", "_terrainInfo", "_tokenProps"] },
    { name: "DrapePointToTerrain", params: ["_spacePoint", "_sweepDirt", "_terrainInfo", "_tokenProps"] },
    { name: "SplitTerrainByRegion", params: ["_linestring", "_terrainInfo", "_tokenProps"] },
    { name: "CreateTerrainFromTxt", params: ["_filename", "_maxEdge", "_tokenProps", "_modelId"] },
    { name: "CreateTerrainFromPolyface", params: ["_polyfaceArray", "_maxEdge", "_tokenProps", "_modelId"] },
    { name: "ImportSchema", params: ["_tokenProps", "_modelId"] },
    { name: "placeTestLch", params: ["_isInOrigin", "_tokenProps", "_modelId"] },
    { name: "CreateBoreholeFromMdb", params: ["_filename", "_isTransformXY", "_tokenProps", "_modelId"] },
    { name: "AddStandardProperties", params: ["_tokenProps", "_fileContent"] },
    { name: "IsHaveBoreholeProject", params: ["_tokenProps"] },
    { name: "GetCurrBoreholeProjectIds", params: ["_tokenProps", "_modelId"] },
    { name: "GenerateGeologyLayer", params: ["_tokenProps", "_interpolatePrision"] },
    { name: "CreateBoreholeFromXlsx", params: ["_filename", "_isTransformXY", "_tokenProps", "_modelId"] },
    { name: "SaveBoundaryCrvToCurrentBoreholeProject", params: ["_boundaryCrv", "_tokenProps"] },
    { name: "PlaneSliceCurrentModel", params: ["_boundaryCrv", "_tokenProps"] },
    { name: "CliperSliceCurrentModel", params: ["_boundaryCrv", "_cutHeight", "_tokenProps"] },
    { name: "OutPutAllBoreholeTreeNodeData", params: ["_tokenProps"] },
    { name: "UpdateCurrentProjectBoreholeRadius", params: ["_boreholeRad", "_tokenProps"] },
    { name: "EditElementAddhesion", params: ["_tokenProps", "_elementId", "_categoryName", "_proptyName", "_propertyValue"] },
    { name: "ReadBigLayerFromXlsx", params: ["_filename", "_tokenProps", "_modelId"] },
    { name: "GetCurrGeologylayerProps", params: ["_tokenProps"] },
    { name: "DeleteInvestigationElements", params: ["_elementIds", "_tokenProps"] },
    { name: "SavePartitionInfoToCurrentBoreholeProj", params: ["_partitionInfo", "_tokenProps"] }
  ];

  rpcMethods.forEach(method => {
    const button = document.createElement("button");
    button.className = "rpc-button";
    button.textContent = method.name;
    Object.assign(button.style, {
      padding: "8px 6px",
      backgroundColor: "#28a745",
      color: "white",
      border: "none",
      borderRadius: "4px",
      cursor: "pointer",
      fontSize: "12px",
      textAlign: "center",
      wordBreak: "break-word",
      minHeight: "40px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center"
    });

    button.addEventListener("click", async () => {
      try {
        // 真实调用RPC接口
        const result = await realRPCCall(method.name, method.params);
        alert(`RPC调用成功: ${method.name}\n\n参数: ${method.params.join(", ")}\n\n结果: ${JSON.stringify(result, null, 2)}`);

        // 在控制台输出详细信息
        Logger.logInfo("DisplayTestApp", `RPC热加载测试 - ${method.name}: ${JSON.stringify({
          method: method.name,
          params: method.params,
          result,
          timestamp: new Date().toISOString()
        })}`);
      } catch (error) {
        alert(`RPC调用失败: ${method.name}\n\n错误: ${error}`);
        Logger.logError("DisplayTestApp", `RPC调用失败 - ${method.name}: ${error}`);
      }
    });

    // 添加悬停效果
    button.addEventListener("mouseenter", () => {
      button.style.backgroundColor = "#218838";
    });
    button.addEventListener("mouseleave", () => {
      button.style.backgroundColor = "#28a745";
    });

    content.appendChild(button);
  });

  // 组装面板
  panel.appendChild(header);
  panel.appendChild(content);
  document.body.appendChild(panel);

  // 添加拖动功能
  makeDraggable(panel, header);

  // 添加关闭按钮功能
  const closeButton = document.getElementById("close-panel") as HTMLButtonElement;
  closeButton.addEventListener("click", () => {
    panel.style.display = "none";
  });

  // 添加面板大小变化监听
  let resizeObserver: ResizeObserver | null = null;
  if ('ResizeObserver' in window) {
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        Logger.logInfo("DisplayTestApp", `面板大小调整: ${width}x${height}`);

        // 根据面板大小动态调整按钮布局
        const buttons = content.querySelectorAll('.rpc-button');
        buttons.forEach(button => {
          const htmlButton = button as HTMLElement;
          if (width < 320) {
            htmlButton.style.fontSize = "10px";
            htmlButton.style.padding = "6px 4px";
          } else {
            htmlButton.style.fontSize = "12px";
            htmlButton.style.padding = "8px 6px";
          }
        });
      }
    });
    resizeObserver.observe(panel);
  }
}

// 文件选择工具函数
async function selectFile(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;

    input.onchange = () => {
      if (input.files) {
        resolve(Array.from(input.files));
      } else {
        resolve([]);
      }
    };

    input.click();
  });
}

// 文件夹选择工具函数
async function selectFolder(): Promise<string> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;

    input.onchange = () => {
      if (input.files && input.files.length > 0) {
        // 返回第一个文件的路径（实际上浏览器安全限制不允许直接获取完整路径）
        resolve(input.files[0].webkitRelativePath.split('/')[0] || 'selected-folder');
      } else {
        resolve('');
      }
    };

    input.click();
  });
}

// 将文件读取为Uint8Array
async function fileToUint8Array(file: File): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(new Uint8Array(reader.result));
      } else {
        resolve(new Uint8Array());
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

// 真实RPC调用
async function realRPCCall(methodName: string, _params: string[]) {
  // 动态导入地质插件模块
  let geologyModule;
  try {
    geologyModule = await import("../../plugins/GeologyPlugin/geologybim-common/lib/esm/SZEWGeologyBIMCommon");
  } catch (error) {
    console.warn("Failed to load geology plugin module", error);
    return;
  }

  const SZEWGeologyBIMRpcInterface = geologyModule.SZEWGeologyBIMRpcInterface;
  const isRegistered = RpcRegistry.instance.definitionClasses.has(SZEWGeologyBIMRpcInterface.interfaceName);
  if (!isRegistered) {
    return;
  }
  const client = SZEWGeologyBIMRpcInterface.getClient();

  // 准备默认参数
  const defaultTokenProps = { key: "test-key" };
  const defaultModelId = "0x123";

  // 根据方法名调用对应的RPC方法
  switch (methodName) {
    case "GetAllTerrainInfo":
      return client.GetAllTerrainInfo(defaultTokenProps);

    case "SweepLinestringToTerrain":
      // 使用测试几何数据
      return client.SweepLinestringToTerrain(
        [
          { x: 100, y: 200, z: 0 },
          { x: 200, y: 300, z: 0 },
          { x: 300, y: 400, z: 0 }
        ], // _linestring: 测试线串
        { x: 0, y: 0, z: 1 }, // _sweepDirt: 清扫方向（向上）
        {
          terrainId: "0x1",
          range: {
            low: { x: 0, y: 0, z: 0 },
            high: { x: 1000, y: 1000, z: 100 }
          }
        }, // _terrainInfo: 测试地形信息
        defaultTokenProps
      );

    case "DrapePointToTerrain":
      return client.DrapePointToTerrain(
        { x: 500, y: 500, z: 50 }, // _spacePoint: 测试空间点
        { x: 0, y: 0, z: -1 }, // _sweepDirt: 清扫方向（向下）
        {
          terrainId: "0x1",
          range: {
            low: { x: 0, y: 0, z: 0 },
            high: { x: 1000, y: 1000, z: 100 }
          }
        }, // _terrainInfo: 测试地形信息
        defaultTokenProps
      );

    case "SplitTerrainByRegion":
      return client.SplitTerrainByRegion(
        [
          { x: 100, y: 100, z: 0 },
          { x: 200, y: 100, z: 0 },
          { x: 200, y: 200, z: 0 },
          { x: 100, y: 200, z: 0 }
        ], // _linestring: 测试边界线串
        {
          terrainId: "0x1",
          range: {
            low: { x: 0, y: 0, z: 0 },
            high: { x: 1000, y: 1000, z: 100 }
          }
        }, // _terrainInfo: 测试地形信息
        defaultTokenProps
      );

    case "CreateTerrainFromTxt":
      // 选择txt文件
      const txtFiles = await selectFile('.txt');
      if (txtFiles.length === 0) {
        throw new Error('未选择txt文件');
      }
      return client.CreateTerrainFromTxt(
        txtFiles[0].name, // _filename: 选择的txt文件名
        50, // _maxEdge: 最大边长度
        defaultTokenProps,
        defaultModelId // _modelId: 模型ID
      );

    case "CreateTerrainFromPolyface":
      return client.CreateTerrainFromPolyface(
        ["0x101", "0x102", "0x103"], // _polyfaceArray: 测试多面体ID数组
        50, // _maxEdge: 最大边长度
        defaultTokenProps,
        defaultModelId // _modelId: 模型ID
      );

    case "ImportSchema":
      return client.ImportSchema(defaultTokenProps, defaultModelId);

    case "placeTestLch":
      return client.placeTestLch(true, defaultTokenProps, defaultModelId);

    case "CreateBoreholeFromMdb":
      // 选择mdb文件
      const mdbFiles = await selectFile('.mdb');
      if (mdbFiles.length === 0) {
        throw new Error('未选择mdb文件');
      }
      // 使用文件名而不是文件内容
      return client.CreateBoreholeFromMdb(
        mdbFiles[0].name, // _filename: mdb文件名
        true, // _isTransformXY: 转换XY坐标
        defaultTokenProps,
        defaultModelId // _modelId: 模型ID
      );

    case "AddStandardProperties":
      // 选择文件夹
      const folderPath = await selectFolder();
      if (!folderPath) {
        throw new Error('未选择文件夹');
      }
      // 模拟文件夹内容
      const folderContent = new TextEncoder().encode(JSON.stringify({
        folder: folderPath,
        files: ['standard1.json', 'standard2.json'],
        timestamp: new Date().toISOString()
      }));
      return client.AddStandardProperties(defaultTokenProps, folderContent);

    case "IsHaveBoreholeProject":
      return client.IsHaveBoreholeProject(defaultTokenProps);

    case "GetCurrBoreholeProjectIds":
      return client.GetCurrBoreholeProjectIds(defaultTokenProps, defaultModelId);

    case "GenerateGeologyLayer":
      return client.GenerateGeologyLayer(defaultTokenProps, 5); // _interpolatePrision: 插值精度

    case "CreateBoreholeFromXlsx":
      // 选择excel文件
      const excelFiles = await selectFile('.xlsx,.xls');
      if (excelFiles.length === 0) {
        throw new Error('未选择excel文件');
      }
      // 读取所有选择的excel文件
      const excelFileContents = await Promise.all(
        excelFiles.map(async file => fileToUint8Array(file))
      );
      return client.CreateBoreholeFromXlsx(
        excelFileContents, // _filename: excel文件内容数组
        true, // _isTransformXY: 转换XY坐标
        defaultTokenProps,
        defaultModelId // _modelId: 模型ID
      );

    case "SaveBoundaryCrvToCurrentBoreholeProject":
      // 使用空的几何流数据
      return client.SaveBoundaryCrvToCurrentBoreholeProject(
        [], // _boundaryCrv: 空几何流数据
        defaultTokenProps
      );

    case "PlaneSliceCurrentModel":
      return client.PlaneSliceCurrentModel(
        [], // _boundaryCrv: 空边界曲线
        defaultTokenProps
      );

    case "CliperSliceCurrentModel":
      return client.CliperSliceCurrentModel(
        [], // _boundaryCrv: 空边界曲线
        20, // _cutHeight: 切割高度
        defaultTokenProps
      );

    case "OutPutAllBoreholeTreeNodeData":
      return client.OutPutAllBoreholeTreeNodeData(defaultTokenProps);

    case "UpdateCurrentProjectBoreholeRadius":
      return client.UpdateCurrentProjectBoreholeRadius(2.5, defaultTokenProps); // _boreholeRad: 钻孔半径

    case "EditElementAddhesion":
      return client.EditElementAddhesion(
        defaultTokenProps,
        "0x201", // _elementId: 测试元素ID
        "地质分类", // _categoryName: 分类名称
        "岩性", // _proptyName: 属性名称
        "砂岩"  // _propertyValue: 属性值
      );

    case "ReadBigLayerFromXlsx":
      // 选择excel文件
      const bigLayerFiles = await selectFile('.xlsx,.xls');
      if (bigLayerFiles.length === 0) {
        throw new Error('未选择excel文件');
      }
      const bigLayerFileContent = await fileToUint8Array(bigLayerFiles[0]);
      return client.ReadBigLayerFromXlsx(
        bigLayerFileContent, // _filename: excel文件内容
        defaultTokenProps,
        defaultModelId // _modelId: 模型ID
      );

    case "GetCurrGeologylayerProps":
      return client.GetCurrGeologylayerProps(defaultTokenProps);

    case "DeleteInvestigationElements":
      return client.DeleteInvestigationElements(
        ["0x301", "0x302", "0x303"], // _elementIds: 测试元素ID数组
        defaultTokenProps
      );

    case "SavePartitionInfoToCurrentBoreholeProj":
      return client.SavePartitionInfoToCurrentBoreholeProj(
        [], // _partitionInfo: 空分区信息
        defaultTokenProps
      );

    default:
      throw new Error(`未知的RPC方法: ${methodName}`);
  }
}

// 使元素可拖动
function makeDraggable(element: HTMLElement, handle: HTMLElement) {
  let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;

  handle.onmousedown = dragMouseDown;

  function dragMouseDown(e: MouseEvent) {
    e.preventDefault();
    // 获取鼠标初始位置
    pos3 = e.clientX;
    pos4 = e.clientY;
    document.onmouseup = closeDragElement;
    document.onmousemove = elementDrag;
  }

  function elementDrag(e: MouseEvent) {
    e.preventDefault();
    // 计算新的位置
    pos1 = pos3 - e.clientX;
    pos2 = pos4 - e.clientY;
    pos3 = e.clientX;
    pos4 = e.clientY;
    // 设置元素的新位置
    element.style.top = `${element.offsetTop - pos2}px`;
    element.style.left = `${element.offsetLeft - pos1}px`;
    element.style.right = "auto";
  }

  function closeDragElement() {
    document.onmouseup = null;
    document.onmousemove = null;
  }
}

function showSpinner() {
  const spinner = document.getElementById("spinner") as HTMLElement;
  spinner.style.display = "block";
}

function hideSpinner() {
  const spinner = document.getElementById("spinner");
  if (spinner)
    spinner.style.display = "none";
}

// Entry point - run the main function
dtaFrontendMain(); // eslint-disable-line @typescript-eslint/no-floating-promises
