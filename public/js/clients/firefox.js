"use strict";

const { DebuggerClient } = require("ff-devtools-libs/shared/client/main");
const { DebuggerTransport } = require("ff-devtools-libs/transport/transport");
const { TargetFactory } = require("ff-devtools-libs/client/framework/target");
const {
  Tab, Source, Location, BreakpointResult, Frame
} = require("../types");
const defer = require("../util/defer");

let currentClient = null;
let currentThreadClient = null;
let currentTabTarget = null;

// API implementation

let APIClient = {
  _bpClients: {},

  resume() {
    return new Promise(resolve => {
      currentThreadClient.resume(resolve);
    });
  },

  stepIn() {
    return new Promise(resolve => {
      currentThreadClient.stepIn(resolve);
    });
  },

  stepOver() {
    return new Promise(resolve => {
      currentThreadClient.stepOver(resolve);
    });
  },

  stepOut() {
    return new Promise(resolve => {
      currentThreadClient.stepOut(resolve);
    });
  },

  getSources() {
    return currentThreadClient.getSources();
  },

  sourceContents(sourceId) {
    const sourceClient = currentThreadClient.source({ actor: sourceId });
    return sourceClient.source();
  },

  setBreakpoint(location, condition) {
    const sourceClient = currentThreadClient.source({
      actor: location.sourceId
    });
    return sourceClient.setBreakpoint({
      line: location.line,
      column: location.column,
      condition: condition
    }).then(([res, bpClient]) => {
      this._bpClients[bpClient.actor] = bpClient;

      // Firefox only returns `actualLocation` if it actually changed,
      // but we want it always to exist. Format `actualLocation` if it
      // exists, otherwise use `location`.
      const actualLocation = res.actualLocation ? {
        sourceId: res.actualLocation.source.actor,
        line: res.actualLocation.line,
        column: res.actualLocation.column
      } : location;

      return BreakpointResult({
        id: bpClient.actor,
        actualLocation: Location(actualLocation)
      });
    });
  },

  removeBreakpoint(breakpointId) {
    const bpClient = this._bpClients[breakpointId];
    this._bpClients[breakpointId] = null;
    return bpClient.remove();
  },

  evaluate(script) {
    const deferred = defer();

    currentTabTarget.activeConsole.evaluateJS(script, (result) => {
      deferred.resolve(result);
    });

    return deferred.promise;
  },

  navigate(url) {
    return currentTabTarget.activeTab.navigateTo(url);
  },

  getProperties(grip) {
    const objClient = currentThreadClient.pauseGrip(grip);
    return objClient.getPrototypeAndProperties();
  }
};

function getAPIClient() {
  return APIClient;
}

// Connection handling

function getThreadClient() {
  return currentThreadClient;
}

function setThreadClient(client) {
  currentThreadClient = client;
}

function getTabTarget() {
  return currentTabTarget;
}

function setTabTarget(target) {
  currentTabTarget = target;
}

function lookupTabTarget(tab) {
  const options = { client: currentClient, form: tab, chrome: false };
  return TargetFactory.forRemoteTab(options);
}

function createTabs(tabs) {
  return tabs.map(tab => {
    return Tab({
      title: tab.title,
      url: tab.url,
      id: tab.actor,
      tab,
      browser: "firefox"
    });
  });
}

function connectClient() {
  const deferred = defer();
  let isConnected = false;

  const socket = new WebSocket("ws://localhost:9000");
  const transport = new DebuggerTransport(socket);
  currentClient = new DebuggerClient(transport);

  // TODO: the timeout logic should be moved to DebuggerClient.connect.
  setTimeout(() => {
    if (isConnected) {
      return;
    }

    deferred.resolve([]);
  }, 1000);

  currentClient.connect().then(() => {
    isConnected = true;
    return currentClient.listTabs().then(response => {
      deferred.resolve(createTabs(response.tabs));
    });
  }).catch(err => {
    console.log(err);
    deferred.reject();
  });

  return deferred.promise;
}

function connectTab(tab) {
  return new Promise((resolve, reject) => {
    window.addEventListener("beforeunload", () => {
      getTabTarget().destroy();
    });

    lookupTabTarget(tab).then(target => {
      currentTabTarget = target;
      target.activeTab.attachThread({}, (res, threadClient) => {
        threadClient.resume();
        currentThreadClient = threadClient;
        resolve();
      });
    });
  });
}

function createFrame(frame) {
  let title;
  if (frame.type == "call") {
    let c = frame.callee;
    title = c.name || c.userDisplayName || c.displayName || "(anonymous)";
  } else {
    title = "(" + frame.type + ")";
  }

  return Frame({
    id: frame.actor,
    displayName: title,
    location: Location({
      sourceId: frame.where.source.actor,
      line: frame.where.line,
      column: frame.where.column
    }),
    scope: frame.environment
  });
}

const CALL_STACK_PAGE_SIZE = 25;
const NEW_SOURCE_IGNORED_URLS = ["debugger eval code", "XStringBundle"];

function makeDispatcher(client, actions) {
  return {
    paused(_, packet) {
      // If paused by an explicit interrupt, which are generated by the
      // slow script dialog and internal events such as setting
      // breakpoints, ignore the event.
      if (packet.why.type === "interrupted" && !packet.why.onNext) {
        return;
      }

      // Eagerly fetch the frames
      client.getFrames(0, CALL_STACK_PAGE_SIZE, res => {
        actions.loadedFrames(res.frames.map(createFrame));
      });

      const pause = Object.assign({}, packet, {
        frame: createFrame(packet.frame)
      });
      actions.paused(pause);
    },

    resumed(_, packet) {
      actions.resumed(packet);
    },

    newSource(_, packet) {
      const { source } = packet;

      if (NEW_SOURCE_IGNORED_URLS.indexOf(source.url) === -1) {
        actions.newSource(Source({
          id: source.actor,
          url: source.url
        }));
      }
    }
  };
}

function initPage(actions) {
  const tabTarget = getTabTarget();
  const client = getThreadClient();

  tabTarget.on("will-navigate", actions.willNavigate);
  tabTarget.on("navigate", actions.navigate);

  const dispatcher = makeDispatcher(client, actions);

  // Listen to all the requested events.
  Object.keys(dispatcher).forEach(eventName => {
    client.addListener(eventName, dispatcher[eventName]);
  });

  // In Firefox, we need to initially request all of the sources which
  // makes the server iterate over them and fire individual
  // `newSource` notifications. We don't need to do anything with the
  // response since `newSource` notifications are fired.
  client.getSources();
}

module.exports = {
  connectClient,
  connectTab,
  getAPIClient,
  getThreadClient,
  setThreadClient,
  getTabTarget,
  setTabTarget,
  initPage
};