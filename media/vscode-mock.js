window.chrome = window.chrome || {};

if (!window.chrome.runtime) {
    window.chrome.runtime = {};
}

if (!window.chrome.runtime.sendMessage) {
    window.chrome.runtime.sendMessage = function(message, callback) {
        console.log("[VSCodeProxy] Mock sendMessage:", message);
        if (callback) callback();
    };
}

if (!window.chrome.tabs) {
    window.chrome.tabs = {
        create: function(details) {
            console.log("[VSCodeProxy] Mock tabs.create:", details);
            if (details.url) {
                postOpenExternal(details.url);
            }
        },
        query: function(queryInfo, callback) {
            if (callback) callback([]);
        }
    };
}

if (!window.chrome.runtime.getURL) {
    window.chrome.runtime.getURL = function(path) {
        return path;
    };
}

if (!window.chrome.runtime.onMessage) {
    window.chrome.runtime.onMessage = {
        addListener: function() {}
    };
}

if (!window.chrome.runtime.getManifest) {
    window.chrome.runtime.getManifest = function() {
        return { version_name: "VSCode Port" };
    };
}

if (!window.chrome.i18n) {
    window.chrome.i18n = {
        getMessage: function(message) {
            return message;
        }
    };
}

// Mock chrome.extension (deprecated but used by some extensions)
if (!window.chrome.extension) {
    window.chrome.extension = {
        inIncognitoContext: false
    };
}

// --- UTILITIES ---

// Helper to rewrite chrome-extension URL to localhost URL
function rewriteChromeUrl(url) {
    if (!url || !url.startsWith("chrome-extension://")) return url;
    const parts = url.split("chrome-extension://");
    if (parts.length > 1) {
        // Remove extension ID part: "ID/filename.html" -> "filename.html"
        const pathParts = parts[1].split("/");
        const path = pathParts.slice(1).join("/");
        return window.location.origin + "/" + path;
    }
    return url;
}

// Helper to post message to VS Code Extension Host
function postOpenExternal(url) {
    if (!url) return;
    
    let targetUrl = url;

    // Resolve relative URLs to absolute
    try {
        const absoluteUrl = new URL(url, window.location.href).href;
        targetUrl = absoluteUrl;
    } catch (e) {
        console.warn("[VSCodeProxy] Could not resolve URL to absolute:", url);
    }

    // Rewrite chrome-extension links to localhost links
    targetUrl = rewriteChromeUrl(targetUrl);

    console.log("[VSCodeProxy] Requesting OpenExternal:", targetUrl);
    
    // Strategy 1: Call Local Server Endpoint (Most Reliable for internal iframe)
    fetch('/open-external', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl })
    }).catch(err => {
        console.error("[VSCodeProxy] Failed to call /open-external:", err);
    });

    // Strategy 2: Post Message (Fallback/Legacy)
    window.parent.postMessage({
        command: 'openExternal',
        url: targetUrl
    }, '*');
}

// --- INTERCEPTS ---

// Intercept window.open to handle programmatic navigation
const originalWindowOpen = window.open;
window.open = function(url, target, features) {
    const isSidebar = window.parent !== window;
    if (isSidebar) {
        console.log("[VSCodeProxy] Intercepted window.open:", url);
        postOpenExternal(url);
        return null;
    }
    return originalWindowOpen.call(window, url, target, features);
};

// Intercept Link clicks to open in External Browser
document.addEventListener('click', (e) => {
    // Traverse up to find anchor tag
    let target = e.target;
    while (target && target.tagName !== 'A') {
        target = target.parentElement;
    }

    if (!target || !target.href) return;

    const isSidebar = window.parent !== window;
    const href = target.href; // target.href is always absolute in modern browsers
    const isChromeScheme = href.startsWith("chrome-extension://");

    // Case 1: Chrome Extension Links (Always rewrite)
    if (isChromeScheme) {
        e.preventDefault();
        if (isSidebar) {
             postOpenExternal(href);
        } else {
             // In external browser, navigate to the rewritten URL
             const newUrl = rewriteChromeUrl(href);
             window.location.href = newUrl;
        }
        return;
    }

    // Case 2: Sidebar - Intercept EVERYTHING else
    // We cannot allow the iframe to navigate to external Salesforce pages (X-Frame-Options)
    // or internal pages (we want them in the external browser).
    if (isSidebar) {
        e.preventDefault();
        postOpenExternal(href);
        return;
    }

    // Case 3: External Browser - Native handling for normal links
    // We let the browser handle http/https links naturally.
    console.log("[VSCodeProxy] Ignoring link (native handling):", href);
}, true);
