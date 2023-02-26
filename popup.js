async function toggleEnabled() {
    const storage = await chrome.storage.local.get();
    await chrome.storage.local.set({ enabled: !storage.enabled });
}

async function initialize() {
    const checkbox = document.getElementById('localEnabled');
    const storage = await chrome.storage.local.get();
    if (typeof storage.enabled === "undefined") {
        storage.enabled = true;
        chrome.storage.local.set({ enabled: true });
    }
    checkbox.onchange = toggleEnabled;
    checkbox.checked = storage.enabled;
}

initialize();
