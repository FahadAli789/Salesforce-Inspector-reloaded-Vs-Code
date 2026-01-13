(function() {
    // Flag to prevent double initialization
    if (window.__settingsShimLoaded) return;
    window.__settingsShimLoaded = true;

    console.log('[SettingsShim] Initializing...');

    // 1. Synchronously load settings from VS Code Extension (via Local Server)
    try {
        const xhr = new XMLHttpRequest();
        // Use synchronous request to ensure settings are loaded before any other script runs
        xhr.open('GET', '/settings', false); 
        xhr.send(null);

        if (xhr.status === 200) {
            const settings = JSON.parse(xhr.responseText);
            console.log('[SettingsShim] Loaded settings:', Object.keys(settings).length);
            
            // Populate localStorage
            for (const [key, value] of Object.entries(settings)) {
                // simple localStorage set, bypassing our override usually? 
                // No, we haven't overridden it yet.
                window.localStorage.setItem(key, value);
            }
        } else {
            console.warn('[SettingsShim] Failed to load settings:', xhr.status, xhr.statusText);
        }
    } catch (e) {
        console.error('[SettingsShim] Error loading settings:', e);
    }

    // 2. Override localStorage methods to sync back to server
    const originalSetItem = window.localStorage.setItem;
    const originalRemoveItem = window.localStorage.removeItem;
    const originalClear = window.localStorage.clear;

    // Helper to send update
    function syncSetting(key, value) {
        // We use fetch (async) for writes
        fetch('/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, value }) // value is null for removal
        }).catch(err => console.error('[SettingsShim] Error syncing setting:', err));
    }

    window.localStorage.setItem = function(key, value) {
        // Ensure inputs are strings as per spec
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
    
    // clear is tricky, but let's implement it
    window.localStorage.clear = function() {
        originalClear.call(window.localStorage);
        fetch('/settings/clear', { method: 'POST' })
            .catch(err => console.error('[SettingsShim] Error clearing settings:', err));
    };

    console.log('[SettingsShim] localStorage synchronized with VS Code.');

})();
