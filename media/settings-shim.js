
(function() {
    // Flag to prevent double initialization
    if (window.__settingsShimLoaded) return;
    window.__settingsShimLoaded = true;

    // Wait for vscode API to be available (provided by vscode-shim.js)
    const vscode = window.vscode || (window.acquireVsCodeApi ? window.acquireVsCodeApi() : null);

    console.log('[SettingsShim] Initializing...');

    // 1. Load init settings injected by Extension Host
    if (window.__initialSettings) {
        try {
            const settings = window.__initialSettings;
            console.log('[SettingsShim] Loaded settings from injection:', Object.keys(settings).length);
            
            // Populate localStorage
            // We use the original setItem to avoid triggering our sync logic during init
            const originalSetItem = window.localStorage.setItem;
            for (const [key, value] of Object.entries(settings)) {
                // Determine if we need to parse it? The extension host sends whatever is stored.
                // localStorage stores strings.
                window.localStorage.setItem(key, value);
            }
        } catch (e) {
            console.error('[SettingsShim] Error loading injected settings:', e);
        }
    }

    // 2. Override localStorage methods to sync back to Extension Host
    const originalSetItem = window.localStorage.setItem;
    const originalRemoveItem = window.localStorage.removeItem;
    const originalClear = window.localStorage.clear;

    // Helper to send update
    function syncSetting(key, value) {
        if (vscode) {
            vscode.postMessage({ 
                command: 'settingsUpdate', 
                key: key, 
                value: value 
            });
        }
    }

    window.localStorage.setItem = function(key, value) {
        const stringKey = String(key);
        const stringValue = String(value);
        
        originalSetItem.call(window.localStorage, stringKey, stringValue);
        syncSetting(stringKey, stringValue);
    };

    window.localStorage.removeItem = function(key) {
        const stringKey = String(key);
        originalRemoveItem.call(window.localStorage, stringKey);
        syncSetting(stringKey, null); // null indicates removal
    };
    
    window.localStorage.clear = function() {
        originalClear.call(window.localStorage);
        if (vscode) {
             vscode.postMessage({ command: 'settingsClear' });
        }
    };

    console.log('[SettingsShim] localStorage synchronized with VS Code.');

})();
