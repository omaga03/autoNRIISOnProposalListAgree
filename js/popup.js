document.addEventListener("DOMContentLoaded", () => {
    const listEl = document.getElementById("getListAgree");
    const cookieEl = document.getElementById("nriiscookies");
    const setText = (el, v) => { if (el) el.textContent = String(v ?? "—"); };
  
    chrome.runtime.sendMessage({ method: "getListAgree" }, (res) => {
      if (chrome.runtime.lastError || !res) return setText(listEl, "—");
      setText(listEl, res.val1);
    });
  
    chrome.runtime.sendMessage({ method: "nriiscookies" }, (res) => {
      if (chrome.runtime.lastError || !res) return setText(cookieEl, "—");
      setText(cookieEl, res.val1c);
    });
  });
  