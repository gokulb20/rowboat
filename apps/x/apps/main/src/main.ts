import { app, BrowserWindow, desktopCapturer, protocol, net, shell, session } from "electron";
import path from "node:path";
import {
  setupIpcHandlers,
  startRunsWatcher,
  startServicesWatcher,
  startWorkspaceWatcher,
  stopRunsWatcher,
  stopServicesWatcher,
  stopWorkspaceWatcher
} from "./ipc.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";
// updateElectronApp import removed — auto-updater disabled for Crewm8 builds.
// Re-add this import if you re-enable the updater at the call site below.
import { init as initGmailSync } from "@x/core/dist/knowledge/sync_gmail.js";
import { init as initCalendarSync } from "@x/core/dist/knowledge/sync_calendar.js";
import { init as initFirefliesSync } from "@x/core/dist/knowledge/sync_fireflies.js";
import { init as initGranolaSync } from "@x/core/dist/knowledge/granola/sync.js";
// Background LLM agents disabled in gateway mode — hermes does its own
// graph building, tagging, email labeling, and note summarization on the
// Mac Mini. Running them on the laptop duplicates work and burns tokens.
// import { init as initGraphBuilder } from "@x/core/dist/knowledge/build_graph.js";
// import { init as initEmailLabeling } from "@x/core/dist/knowledge/label_emails.js";
// import { init as initNoteTagging } from "@x/core/dist/knowledge/tag_notes.js";
// import { init as initInlineTasks } from "@x/core/dist/knowledge/inline_tasks.js";
// import { init as initAgentNotes } from "@x/core/dist/knowledge/agent_notes.js";
import { init as initAgentRunner } from "@x/core/dist/agent-schedule/runner.js";
import { initConfigs } from "@x/core/dist/config/initConfigs.js";
import started from "electron-squirrel-startup";
import { execSync, exec, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { init as initChromeSync } from "@x/core/dist/knowledge/chrome-extension/server/server.js";
// Crewm8 MCP server — exposes builtin tools to the remote hermes agent so
// it can act on the laptop's filesystem over Tailscale (MCP bridge).
import { startMcpServer, stopMcpServer } from "@x/core/dist/mcp-server/server.js";

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// run this as early in the main process as possible
if (started) app.quit();

// Note: app.setName() is no longer needed here — the packaged .app is named
// Crewm8 via productName in package.json, so Electron derives the correct
// name automatically. The previous runtime override (2026-04-11 Phase 2a)
// was removed in the full rebrand when the bundle itself became Crewm8.

// Fix PATH for packaged Electron apps on macOS/Linux.
// Packaged apps inherit a minimal environment that doesn't include paths from
// the user's shell profile (such as those provided by nvm, Homebrew, etc.).
// The function below spawns the user's login shell and runs a Node.js one-liner
// to print the full environment as JSON, then merges it into process.env.
// This ensures the Electron app has the same PATH and environment as user shell
// (helping find tools installed via Homebrew/nvm/npm, etc.)
function initializeExecutionEnvironment(): void {
  if (process.platform === 'win32') return;

  const shell = process.env.SHELL || '/bin/zsh';

  try {
    const stdout = execFileSync(
      shell,
      ['-l', '-c', `node -p "JSON.stringify(process.env)"`],
      { encoding: 'utf8' }
    ).trim();

    const env = JSON.parse(stdout) as Record<string, string>;
    process.env = { ...env, ...process.env };
  } catch (error) {
    console.error('Failed to load shell environment', error);
  }
}
initializeExecutionEnvironment();

// Path resolution differs between development and production:
const preloadPath = app.isPackaged
  ? path.join(__dirname, "../preload/dist/preload.js")
  : path.join(__dirname, "../../../preload/dist/preload.js");
console.log("preloadPath", preloadPath);

const rendererPath = app.isPackaged
  ? path.join(__dirname, "../renderer/dist") // Production
  : path.join(__dirname, "../../../renderer/dist"); // Development
console.log("rendererPath", rendererPath);

// Register custom protocol for serving built renderer files in production.
// This keeps SPA routes working when users deep link into the packaged app.
function registerAppProtocol() {
  protocol.handle("app", (request) => {
    const url = new URL(request.url);

    // url.pathname starts with "/"
    let urlPath = url.pathname;

    // If it's "/" or a SPA route (no extension), serve index.html
    if (urlPath === "/" || !path.extname(urlPath)) {
      urlPath = "/index.html";
    }

    const filePath = path.join(rendererPath, urlPath);
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      allowServiceWorkers: true,
      // optional but often helpful:
      // stream: true,
    },
  },
]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 600,
    minHeight: 480,
    show: false, // Don't show until ready
    backgroundColor: "#252525", // Prevent white flash (matches dark mode)
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 12 },
    title: "Crewm8",
    webPreferences: {
      // IMPORTANT: keep Node out of renderer
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: preloadPath,
    },
  });

  // Grant microphone and display-capture permissions
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media' || permission === 'display-capture') {
      callback(true);
    } else {
      callback(false);
    }
  });

  // Auto-approve display media requests and route system audio as loopback.
  // Electron requires a video source in the callback even if we only want audio.
  // We pass the first available screen source; the renderer discards the video track.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    if (sources.length === 0) {
      callback({});
      return;
    }
    callback({ video: sources[0], audio: 'loopback' });
  });

  // Show window when content is ready to prevent blank screen
  win.once("ready-to-show", () => {
    win.maximize();
    win.show();
  });

  // Open external links in system browser (not sandboxed Electron window)
  // This handles window.open() and target="_blank" links
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Handle navigation to external URLs (e.g., clicking a link without target="_blank")
  win.webContents.on("will-navigate", (event, url) => {
    const isInternal =
      url.startsWith("app://") || url.startsWith("http://localhost:5173");
    if (!isInternal) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  if (app.isPackaged) {
    win.loadURL("app://-/index.html");
  } else {
    win.loadURL("http://localhost:5173");
  }
}

app.whenReady().then(async () => {
  // Register custom protocol before creating window (for production builds)
  if (app.isPackaged) {
    registerAppProtocol();
  }

  // Auto-updater disabled for custom Crewm8 builds.
  //
  // The upstream code pointed at rowboatlabs/rowboat GitHub releases, which
  // would overwrite our Crewm8 customizations on the next upstream release.
  // We keep the import of `updateElectronApp` and `UpdateSourceType` because
  // removing them would ripple through the import list; the call is just
  // commented out. To re-enable later, point `repo` at a fork that publishes
  // custom builds.
  //
  // if (app.isPackaged) {
  //   updateElectronApp({
  //     updateSource: {
  //       type: UpdateSourceType.ElectronPublicUpdateService,
  //       repo: "your-fork/crewm8-desktop",
  //     },
  //     notifyUser: true,
  //   });
  // }

  // Ensure agent-slack CLI is available
  try {
    execSync('agent-slack --version', { stdio: 'ignore', timeout: 5000 });
  } catch {
    try {
      console.log('agent-slack not found, installing...');
      await execAsync('npm install -g agent-slack', { timeout: 60000 });
      console.log('agent-slack installed successfully');
    } catch (e) {
      console.error('Failed to install agent-slack:', e);
    }
  }

  // Initialize all config files before UI can access them
  await initConfigs();

  setupIpcHandlers();

  createWindow();

  // Start workspace watcher as a main-process service
  // Watcher runs independently and catches ALL filesystem changes:
  // - Changes made via IPC handlers (workspace:writeFile, etc.)
  // - External changes (terminal, git, other editors)
  // Only starts once (guarded in startWorkspaceWatcher)
  startWorkspaceWatcher();

  // start runs watcher
  startRunsWatcher();

  // start services watcher
  startServicesWatcher();

  // start gmail sync
  initGmailSync();

  // start calendar sync
  initCalendarSync();

  // start fireflies sync
  initFirefliesSync();

  // start granola sync
  initGranolaSync();

  // Background LLM agents disabled in gateway mode. Hermes on the Mac Mini
  // handles graph building, note tagging, email labeling, and agent notes
  // on its own side. Running these locally duplicates work and burns tokens.
  //   initGraphBuilder();
  //   initEmailLabeling();
  //   initNoteTagging();
  //   initInlineTasks();
  //   initAgentNotes();

  // start background agent runner (scheduled agents — user-defined schedules)
  initAgentRunner();

  // start chrome extension sync server
  initChromeSync();

  // start Crewm8 MCP server — exposes builtin tools (executeCommand,
  // workspace-readFile, workspace-grep, etc.) to the remote hermes agent
  // over Tailscale. Bound to 0.0.0.0:8643 so hermes on 100.127.242.92 can
  // dial back. This is the "local hands for remote brain" bridge.
  startMcpServer(Number(process.env.CREWM8_MCP_PORT ?? 8643)).catch((err) => {
    console.error("[main] Failed to start Crewm8 MCP server:", err);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  // Clean up watcher on app quit
  stopWorkspaceWatcher();
  stopRunsWatcher();
  stopServicesWatcher();
  stopMcpServer().catch(() => { /* best-effort */ });
});
