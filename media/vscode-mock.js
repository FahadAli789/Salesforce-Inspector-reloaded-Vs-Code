// --- VSCODE API MOCK ---
window.chrome = window.chrome || {};

if (!window.chrome.runtime) {
    window.chrome.runtime = {};
}

// Only add if not present (shim might have added them)
if (!window.chrome.runtime.sendMessage) {
    window.chrome.runtime.sendMessage = function(message, callback) {
        if (callback) callback();
    };
}

if (!window.chrome.tabs) {
    window.chrome.tabs = {
        create: function(details) {
            if (details.url) {
                if (window.openExternal) {
                    window.openExternal(details.url);
                } else if (window.vscode) {
                    window.vscode.postMessage({ command: 'openExternal', url: details.url });
                }
            }
        },
        query: function(queryInfo, callback) {
            if (callback) callback([]);
        }
    };
}

if (!window.chrome.i18n) {
    window.chrome.i18n = {
        getMessage: function(message) {
            return message;
        }
    };
}

if (!window.chrome.extension) {
    window.chrome.extension = {
        inIncognitoContext: false
    };
}

// Intercept window.open
const originalWindowOpen = window.open;
window.open = function(url, target, features) {
    console.log("[VSCodeProxy] Intercepted window.open:", url);
    // Relative URLs (internal pages) should use navigate message if "target" is not _blank
    if (url && !url.startsWith('http') && target !== '_blank') {
         if (window.vscode) {
             window.vscode.postMessage({ command: 'navigate', path: url });
             return null;
         }
    }
    
    // External links or _blank
    if (window.openExternal) {
        window.openExternal(url);
    } else if (window.vscode) {
        window.vscode.postMessage({ command: 'openExternal', url: url });
    }
    return null;
};
