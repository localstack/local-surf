/*
 * This script provides LocalSurf - a Chrome browser extension that allows to
 * easily test Web applications against LocalStack. Once enabled, LocalSurf
 * intercepts all API calls made to AWS services (*.amazonaws.com) and redirects
 * the calls to LocalStack (running on http://localhost:4566 by default).
 */

// keeping track of AJAX requests (XMLHttpRequest) made by the browser
const REQUESTS = {};

// determine whether we are in the context of the page script or the content script
const isExtensionContext = !!chrome.runtime;
const isPageContext = !isExtensionContext;

/**
 * Patch XMLHttpRequest
 */
const patchXMLHttpRequest = () => {

    // add all proxy getters, with fallback to _attribute
    const attrs = ["statusText", "responseType", "response", "responseText", "readyState", "responseXML", "status", "upload"];
    attrs.forEach(function(item) {
        const oldProp = Object.getOwnPropertyDescriptor(window.XMLHttpRequest.prototype, item);
        Object.defineProperty(window.XMLHttpRequest.prototype, item, {
            get: function() {
                if (this.hasOwnProperty(`_${item}`)) return this[`_${item}`];
                return oldProp.get.bind(this)(item);
            }
        });
    });

    // add all pure proxy pass-through methods
    ["getAllResponseHeaders"].forEach(function(item) {
        const oldProp = Object.getOwnPropertyDescriptor(window.XMLHttpRequest.prototype, item);
        Object.defineProperty(window.XMLHttpRequest.prototype, item, {
            value: function() {
                if (this.hasOwnProperty(`_${item}`)) return this[`_${item}`];
                return oldProp.value.bind(this).apply(arguments);
            }
        });
    });

    const openOrig = XMLHttpRequest.prototype.open;
    const sendOrig = XMLHttpRequest.prototype.send;
    const addEventListenerOrig = XMLHttpRequest.prototype.addEventListener;
    const setRequestHeaderOrig = XMLHttpRequest.prototype.setRequestHeader;

    const _getRequest = (xhrObj) => {
        xhrObj.id = xhrObj.id || String(Math.random());
        REQUESTS[xhrObj.id] = xhrObj;
        return xhrObj;
    };

    const _addListeners = (request) => {
        if (request._listenersAdded) return;
        Object.keys(request.listeners || {}).forEach(key => {
            const args = request.listeners[key];
            request.addEventListener(args[0], ... args.slice(1));
        });
        request._listenersAdded = true;
    }

    XMLHttpRequest.prototype.addEventListener = function(...args) {
        const request = _getRequest(this);
        if (request._isLocalRequest === false) {
            return addEventListenerOrig.bind(this)(args[0], (...args1) => {
                return args[1](...args1);
            });
        }
        request.listeners = request.listeners || {};
        args[1] = args[1].bind(request);
        request.listeners[args[0]] = args;
    }
    XMLHttpRequest.prototype.open = function(...args) {
        const regex = /^https:\/\/(([a-z0-9-]+\.)+)amazonaws\.com:?[0-9]*\/.*/;
        const match = args[1].match(regex);
        if (args.length > 2 && match) {
            const path = _partition(_partition(args[1], "://")[1], "/")[1];
            args[1] = `https://localhost.localstack.cloud:4566/${path}`;
            if (match[1].match(/.*execute-api.*/)) {
                args[1] = `https://${match[1]}localhost.localstack.cloud:4566/${path}`;
            }
            const request = _getRequest(this);
            request._isLocalRequest = true;
            return forwardRequest("AJAX_OPEN", request.id, ...args);
        }
        const regex2 = /^https:\/\/([a-z0-9-]+\.)+aws\.amazon\.com:?\/(?!api\/).*/;
        const regex3 = /^\/states\/.*/;
        const isRelPathProxyRequest = args[0] === "POST" && args[1].match(regex3);
        if (args.length > 2 && (args[1].match(regex2) || isRelPathProxyRequest)) {
            const path = isRelPathProxyRequest ? args[1] : _partition(_partition(args[1], "://")[1], "/")[1];
            args[1] = `https://localhost.localstack.cloud:4566`;
            const request = _getRequest(this);
            request._isLocalRequest = true;
            request._isRelPathRequest = !!isRelPathProxyRequest;
            var service = path.split("/")[path.split("/").length - 1];
            if (service === "statemachines") service = "stepfunctions";
            const newPath = path;
            request._proxy_request = { service, path: newPath, open_args: args };
            if (path === "/states/service/statemachines") {
                request._proxy_request.headers = {
                    "x-amz-target": "AWSStepFunctions.ListStateMachines"
                }
            }
            return;
        }
        // fall back to regular request
        const request = REQUESTS[this.id] || this;
        request._isLocalRequest = false;
        _addListeners(request);
        return openOrig.bind(this)(...args);
    }
    XMLHttpRequest.prototype.send = function(...args) {
        const request = _getRequest(this);
        if (request._isLocalRequest === false) {
            _addListeners(this);
            return sendOrig.bind(this)(...args);
        }
        if (request._proxy_request) {
            const proxy_request = request._proxy_request;
            var params = proxy_request;
            if (!request._isRelPathRequest) {
                var params = JSON.parse(args);
                args = [params.contentString];
            }
            if (!proxy_request.open_sent) {
                proxy_request.open_args[0] = params.method || proxy_request.open_args[0];
                proxy_request.open_args[1] = `https://localhost.localstack.cloud:4566${params.path || "/"}`;
                forwardRequest("AJAX_OPEN", request.id, ...(proxy_request.open_args));
                proxy_request.open_sent = true;
            }
            // set request headers
            Object.keys(params.headers || {}).forEach(key => this.setRequestHeader(key, params.headers[key]));
            // TODO: set proper date!
            this.setRequestHeader("Authorization", `AWS4-HMAC-SHA256 Credential=test/20230129/${params.region}/${proxy_request.service}/aws4_request`);
        }
        forwardRequest("AJAX_SEND", request.id, ...args);
    }
    XMLHttpRequest.prototype.setRequestHeader = function(...args) {
        const request = _getRequest(this);
        if (request._isLocalRequest === false) {
            _addListeners(this);
            return setRequestHeaderOrig.bind(this)(...args);
        }
        forwardRequest("AJAX_HEADER", request.id, ...args);
    }
}

/**
 * Patch the fetch(..) API to repoint *.amazonaws.com requests to localhost
 */
const patchFetchAPI = () => {

    const fetchOrig = fetch;
    window.fetch = async function(...args) {
        const regex = /^https:\/\/([a-z0-9-]+\.)+amazonaws\.com:?\/.*/;
        const isExcluded = args[0].match(/.*unifiedsearch\.amazonaws\.com.*/);
        if (args.length > 0 && !isExcluded && args[0].match(regex)) {
            const path = _partition(_partition(args[0], "://")[1], "/")[1];
            args[0] = `https://localhost.localstack.cloud:4566/${path}`;
        }
        return fetchOrig(...args);
    }
}


/**
 * Handler function to handle event messages exchanged between
 * the page script and the content script.
 */
const handleEventMessage = (event) => {

    // We only accept messages from ourselves
    if (event.source != window) return;

    const select = (object, attrs) => attrs.reduce((obj, attr) => ({... obj, [attr]: object[attr]}), {});

    if (isExtensionContext && event.data.type == "AJAX_OPEN") {
        const request = REQUESTS[event.data.id] = new XMLHttpRequest();
        const events = ["readystatechange", "progress", "error", "abort", "load", "beforesend", "loadstart", "loadend", "timeout"];
        events.forEach(eventName => {
            request.addEventListener(eventName, (...args) => {
                const attributes = [
                    "isTrusted", "bubbles", "cancelBubble", "cancelable", "composed", "defaultPrevented",
                    "eventPhase", "lengthComputable", "loaded", "path", "returnValue", "timeStamp", "total", "type"
                ];
                var eventArgs = args;
                if (args.length) {
                    args[0] = select(args[0], attributes);
                }
                const xhrState = select(request, ["readyState", "response", "responseType", "responseText", "status", "statusCode", "statusText"]);
                xhrState["getAllResponseHeaders"] = request.getAllResponseHeaders();
                forwardRequest("AJAX_STATE", event.data.id, {event: eventName, args: eventArgs, xhrState});
            });
        });
        request.open(... event.data.args);
    } else if (isExtensionContext && event.data.type == "AJAX_SEND") {
        const request = REQUESTS[event.data.id];
        if (!request) return;
        request.send(... event.data.args);
    } else if (isExtensionContext && event.data.type == "AJAX_HEADER") {
        const request = REQUESTS[event.data.id];
        if (!request) return;
        request.setRequestHeader(... event.data.args);
    } else if (isPageContext && event.data.type == "AJAX_STATE") {
        const request = REQUESTS[event.data.id];
        if (!request) return;
        const stateEvent = event.data.args[0];

        // modify response
        if (request._isRelPathRequest) {
            (event.data.args || []).forEach(e => {
                const state = e.xhrState || {};
                if (state.readyState === 3) {
                    const response = JSON.parse(state.response);
                }
            });
        }

        const listener = request.listeners && request.listeners[stateEvent.event];
        if (!listener) return;
        Object.keys(stateEvent.xhrState).forEach(attr => {
            request[`_${attr}`] = stateEvent.xhrState[attr];
            listener[1][attr] = stateEvent.xhrState[attr];
        });
        listener[1](... stateEvent.args.slice(1));
    }
};

// Utility functions below

const _partition = (str, delimiter) => {
    const index = str.indexOf(delimiter);
    const p1 = str.substr(0, index);
    const p2 = str.substr(index + delimiter.length);
    return [p1, p2];
};

const forwardRequest = (type, id, ...args) => {
    const location = window.location;
    const domain = location.protocol + "//" + location.hostname + ":" + location.port;
    window.postMessage({type, id, args}, domain);
};


/**
 * Inject the script into matching pages in the browser
 */
const injectScript = async (file_path, tag) => {
    const storage = await chrome.storage.local.get();
    if (storage.enabled === false) {
        return;
    }
    // inject script tag
    const script = document.createElement("script");
    script.setAttribute("type", "text/javascript");
    script.setAttribute("src", file_path);
    document.getElementsByTagName(tag)[0].appendChild(script);
    // inject menu item in AWS Console
    const node = document.getElementById("awsc-navigation__more-menu--list");
    if (node) {
        const item = node.childNodes[1].cloneNode();
        item.innerHTML = node.childNodes[1].innerHTML;
        node.appendChild(item);
        item.querySelector('[title="Regions"]').innerHTML = "Local Mode";
        item.querySelectorAll('svg')[1].parentElement.innerHTML = '<input type="checkbox" checked="true"/>';
    }
}

// register event handlers (for both, page script and content script)
window.addEventListener("message", handleEventMessage, false);
if (isExtensionContext) {
    // inject the script into the page if we're executing in the content script context
    injectScript(chrome.runtime.getURL("content.js"), "html");
}
if (isPageContext) {
    console.log("Initializing LocalSurf extension, redirecting AWS service calls to LocalStack");

    // apply patches in the context of the page script
    patchXMLHttpRequest();
    patchFetchAPI();
}
