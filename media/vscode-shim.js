
(function() {
    const vscode = acquireVsCodeApi();
    
    // Global Error Handler to pipe errors to VS Code Debug Console
    window.onerror = function(message, source, lineno, colno, error) {
        vscode.postMessage({
            command: 'logError',
            message: message,
            source: source,
            lineno: lineno,
            stack: error ? error.stack : ''
        });
    };

    window.addEventListener('unhandledrejection', event => {
        vscode.postMessage({
            command: 'logError',
            message: 'Unhandled Rejection: ' + event.reason,
            stack: event.reason ? event.reason.stack : ''
        });
    });

    const originalFetch = window.fetch;
    let requestIdCounter = 0;
    const pendingRequests = new Map();

    // Mock chrome.runtime early because inspector.js/popup.js depend on it immediately
    window.chrome = window.chrome || {};
    window.chrome.runtime = window.chrome.runtime || {};
    
    // Some scripts check these immediately
    window.chrome.runtime.getManifest = () => ({ version_name: "VSCode Port" });
    window.chrome.runtime.getURL = (path) => path;
    window.chrome.runtime.onMessage = { addListener: () => {} };

    // Listen for responses from Extension Host
    window.addEventListener('message', event => {
        const message = event.data;
        if (message.command === 'apiResponse') {
            const resolver = pendingRequests.get(message.requestId);
            if (resolver) {
                pendingRequests.delete(message.requestId);
                if (message.isError) {
                    resolver.reject(new TypeError('Network request failed'));
                } else {
                    resolver.resolve(message);
                }
            }
        }
    });

    function createResponse(data, status, statusText, contentType) {
        // Determine the Content-Type: use provided contentType, or guess based on data type
        let effectiveContentType = contentType || (typeof data === 'string' ? 'text/plain' : 'application/json');
        
        return new Response((data!=null) ? (typeof data === 'string' ? data : JSON.stringify(data)) : null, {
            status: status || 200,
            statusText: statusText || 'OK',
            headers: {
                'Content-Type': effectiveContentType
            }
        });
    }

    async function handleProxyRequest(input, init) {
        const requestId = ++requestIdCounter;
        const bodyV = init.body ? JSON.parse(init.body) : {};
        
        return new Promise((resolve, reject) => {
            pendingRequests.set(requestId, { resolve: (msg) => {
                // Determine if we need to return success or error response
                // inspector.js expects fetch failure only on network fail.
                // 401/500 from API should be returned as valid Response with that status.
                
                // If the proxy helper returned an "error: true" flag, it means it got a response but it was an error status
                if (msg.data.error) {
                     // We construct a Response object with the error status
                     resolve(createResponse(msg.data.body, msg.data.status, msg.data.statusText, msg.data.contentType));
                } else {
                     resolve(createResponse(msg.data.body, msg.data.status, undefined, msg.data.contentType));
                }
            }, reject });

            vscode.postMessage({
                command: 'callApi',
                requestId: requestId,
                url: bodyV.url,
                method: bodyV.method,
                headers: bodyV.headers,
                body: bodyV.body
            });
        });
    }

    async function handleCometdRequest(url, init) {
        const requestId = ++requestIdCounter;
        const bodyV = init.body ? JSON.parse(init.body) : {};
        
        return new Promise((resolve, reject) => {
            pendingRequests.set(requestId, { resolve: (msg) => {
                 resolve(createResponse(msg.data.body, msg.data.status));
            }, reject });

            vscode.postMessage({
                command: 'cometd',
                requestId: requestId,
                url: url,
                body: bodyV
            });
        });
    }

    // Override fetch
    window.fetch = async (input, init) => {
        let url = typeof input === 'string' ? input : input.url;
        
        if (url === '/api/proxy') {
            return handleProxyRequest(input, init);
        }
        if (url && url.match && url.match(/^\/cometd\//)) {
            return handleCometdRequest(url, init);
        }
        return originalFetch(input, init);
    };

    // Also generic openExternal override
    window.openExternal = (url) => {
        vscode.postMessage({ command: 'openExternal', url: url});
    };
    
    // Override XMLHttpRequest for CometD
    const OriginalXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function() {
        const xhr = new OriginalXHR();
        let method, url, headers = {};
        
        const originalOpen = xhr.open;
        xhr.open = function(m, u) {
            method = m;
            url = u;
            // Call original open just in case, or to initialize state
            return originalOpen.apply(xhr, arguments);
        };

        const originalSetRequestHeader = xhr.setRequestHeader;
        xhr.setRequestHeader = function(header, value) {
            headers[header] = value;
            return originalSetRequestHeader.apply(xhr, arguments);
        }
        
        const originalSend = xhr.send;
        xhr.send = function(body) {
             if (url && typeof url === 'string' && url.match(/^\/cometd\//)) {
                 const requestId = ++requestIdCounter;
                 const bodyV = body ? JSON.parse(body) : {};

                 pendingRequests.set(requestId, {
                    resolve: (msg) => {
                        // Mock XHR properties
                        Object.defineProperty(xhr, 'status', { value: msg.data.status || 200, writable: true });
                        Object.defineProperty(xhr, 'statusText', { value: msg.data.statusText || 'OK', writable: true });
                        Object.defineProperty(xhr, 'responseText', { value: msg.data.body || '', writable: true });
                        Object.defineProperty(xhr, 'response', { value: msg.data.body || '', writable: true });
                        Object.defineProperty(xhr, 'readyState', { value: 4, writable: true }); // DONE
                        
                        if (xhr.onload) xhr.onload();
                        // CometD uses onload.
                    },
                    reject: (err) => {
                        if (xhr.onerror) xhr.onerror();
                    }
                 });

                 vscode.postMessage({
                    command: 'cometd',
                    requestId: requestId,
                    url: url,
                    body: bodyV
                 });
                 return;
             }
             return originalSend.apply(xhr, arguments);
        }
        return xhr;
    }

    // Intercept Navigation
    document.addEventListener('click', (e) => {
        const target = e.target.closest('a');
        if (!target) return;
        
        const href = target.getAttribute('href');
        console.log('[VSCode Shim] Link clicked. href:', href);
        
        // Check if it's a local navigation (ends in .html and not absolute URL)
        if (href && href.indexOf('.html') > -1 && !href.startsWith('http')) {
             e.preventDefault();
             e.stopPropagation();
             
             console.log('[VSCode Shim] Intercepting navigation to:', href);
             // We want these main tools to open in a new Tab
             vscode.postMessage({ command: 'openInTab', path: href });
        }
    }, true);

    // Make vscode available globally if needed
    window.vscode = vscode;
    
    // Handle Clipboard Shortcuts (CMD+A, CMD+C, CMD+V, CMD+X)
    // VS Code webviews can intercept these shortcuts before they reach input elements
    document.addEventListener('keydown', (e) => {
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const modifier = isMac ? e.metaKey : e.ctrlKey;
        
        // Only handle when modifier key (CMD on Mac, Ctrl on Windows/Linux) is pressed
        if (!modifier) return;
        
        // Only handle when focus is in an input/textarea
        const activeEl = document.activeElement;
        const isInputFocused = activeEl && (
            activeEl.tagName === 'INPUT' || 
            activeEl.tagName === 'TEXTAREA' || 
            activeEl.isContentEditable
        );
        
        if (!isInputFocused) return;
        
        switch (e.key.toLowerCase()) {
            case 'a': // Select All
                e.preventDefault();
                e.stopPropagation();
                if (activeEl.select) {
                    activeEl.select();
                } else {
                    document.execCommand('selectAll', false, null);
                }
                break;
            case 'c': // Copy
                e.preventDefault();
                e.stopPropagation();
                if (window.getSelection) {
                    const selection = window.getSelection().toString();
                    if (selection) {
                        navigator.clipboard.writeText(selection).catch(() => {
                            document.execCommand('copy');
                        });
                    }
                } else {
                    document.execCommand('copy');
                }
                break;
            case 'x': // Cut
                e.preventDefault();
                e.stopPropagation();
                if (window.getSelection) {
                    const selection = window.getSelection().toString();
                    if (selection) {
                        navigator.clipboard.writeText(selection).then(() => {
                            // Delete selected text after copying
                            if (activeEl.selectionStart !== undefined) {
                                const start = activeEl.selectionStart;
                                const end = activeEl.selectionEnd;
                                const value = activeEl.value;
                                activeEl.value = value.slice(0, start) + value.slice(end);
                                activeEl.setSelectionRange(start, start);
                                activeEl.dispatchEvent(new Event('input', { bubbles: true }));
                            }
                        }).catch(() => {
                            document.execCommand('cut');
                        });
                    }
                } else {
                    document.execCommand('cut');
                }
                break;
            case 'v': // Paste
                e.preventDefault();
                e.stopPropagation();
                navigator.clipboard.readText().then(text => {
                    // Create a synthetic paste event
                    // We need clipboardData.getData('text/plain') to return our text
                    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
                    
                    // Create a mock clipboardData object
                    pasteEvent.clipboardData = {
                        getData: (type) => {
                            if (type === 'text/plain' || type === 'text') {
                                return text;
                            }
                            return '';
                        }
                    };
                    
                    // Dispatch the paste event
                    activeEl.dispatchEvent(pasteEvent);
                    
                    // For non-readonly inputs where paste wasn't handled, manually insert text
                    if (activeEl.selectionStart !== undefined && !activeEl.readOnly) {
                        const start = activeEl.selectionStart;
                        const end = activeEl.selectionEnd;
                        const value = activeEl.value;
                        activeEl.value = value.slice(0, start) + text + value.slice(end);
                        const newCursor = start + text.length;
                        activeEl.setSelectionRange(newCursor, newCursor);
                        activeEl.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                }).catch((err) => {
                    console.error('[VSCode Shim] Paste error:', err);
                    // Fallback for when clipboard API is not available
                    document.execCommand('paste');
                });
                break;
        }
    }, true); // Use capture phase to intercept before React/other handlers
    
    console.log('[VSCode Shim] Fetch overridden for Proxy mode');

})();
