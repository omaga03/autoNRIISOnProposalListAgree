// js/background.js (MV3 service worker) - Updated Version

// ---------- Config ----------
const G_SCRIPT = "https://script.google.com/macros/s/AKfycbw-LyYGSjgdZps_BPmNEfDBYXeEDaS0nBSdeeI4y75KmTLhF6luvacqs67mkx1Hvo7e/exec";
const NRIIS_BASE = "https://nriis.go.th";
const NRIIS_LOGIN = `${NRIIS_BASE}/Login.aspx`;
const NRIIS_LIST = `${NRIIS_BASE}/ProposalListAgree.aspx`;
const NAME_PREFIX = "Comet :: ";

// ตั้งค่าระบบ
const MAX_LOGIN_RETRY = 4;          // จำนวนครั้งสูงสุดที่จะลอง Login
const RETRY_DELAY_MINUTES = 2;      // เวลาหน่วงก่อนเริ่มใหม่เมื่อ Error (นาที)

// ---------- State ----------
const state = {
  latestCount: 0,
  latestCookie: "",
  loginAttempt: 0,
  isRunning: false
};

// ---------- Boot ----------
initAlarms();

// เมื่อเปิด Browser หรือติดตั้ง Extension ใหม่ ให้รอ 5 นาทีก่อนเริ่ม
const scheduleStartupDelay = () => {
  log("System Startup detected: Waiting 5 minutes before executing mainStart...");
  chrome.alarms.create("initial_delay", { delayInMinutes: 5 });
};

chrome.runtime.onStartup.addListener(scheduleStartupDelay);
chrome.runtime.onInstalled.addListener(scheduleStartupDelay);

// ---------- Alarms ----------
function initAlarms() {
  chrome.alarms.create("refresh", { periodInMinutes: 60 });

  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === "refresh") {
      log("Alarm: refresh → mainStart()");
      mainStart();
      return;
    }
    if (alarm.name === "initial_delay") {
      log("Alarm: initial_delay (5 minutes passed) → Starting mainStart()");
      mainStart();
      return;
    }
  });
}

// ---------- Message bridge (popup ↔ service worker) ----------
chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  if (req?.method === "getListAgree") {
    sendResponse({ val1: state.latestCount });
    log("Popup opened: Triggering mainStart() via getListAgree...");
    mainStart();
    return;
  }
  if (req?.method === "nriiscookies") {
    sendResponse({ val1c: state.latestCookie });
    return;
  }
});

// ---------- Main flow ----------
async function mainStart() {
  if (state.isRunning) {
    log("mainStart: System is already running. Skipping this trigger.");
    return;
  }

  state.isRunning = true;

  try {
    log("mainStart: starting...");

    // 1. ตรวจสอบการเข้าถึงหน้าเว็บ
    const test = await testAccessProposalList();
    if (!test.ok) {
      log("mainStart: Cannot access page (Session expired?). Trying auto-login...");
      await autoLoginNRIIS();
      return;
    } else {
      log("mainStart: Access OK.");
    }

    // อัปเดต cookie (เผื่อใช้ debug)
    const cookie = await getCookieValue(NRIIS_BASE, "ASP.NET_SessionId");
    state.latestCookie = cookie || "";

    // 2. ดึงข้อมูล (ใช้ระบบใหม่ DOM Parsing)
    const res = await queryProposalListViaDOM();

    const count = Number(res?.count || 0);
    const rows = res?.dataRows || [];

    // Debug Log
    log(`>> Data retrieved: Count = ${count}, Rows found = ${rows.length}`);

    state.latestCount = count;
    setBadge(count);

    // กรณีไม่มีข้อมูล
    if (count === 0) {
      log(`Count = 0 (No proposals)`);
      createNotification(count);
      return;
    }

    // กรณีมี Count > 0 แต่แกะ Rows ไม่ได้ (Error)
    if (rows.length === 0) {
      log("Error: Count > 0 but extracted rows is empty. Check parsing logic.");
      await lineNotifyError(`${NAME_PREFIX}Error : มีจำนวนโครงการแต่ดึงรายละเอียดไม่ได้ (Parse Error)`);
      return;
    }

    createNotification(count);

    // 3. วนลูปส่งข้อมูล (ใช้ข้อมูลจาก Object โดยตรง ไม่ต้อง Regex แล้ว)
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const payload = JSON.stringify({
        a: new Date().toLocaleString("th-TH"),
        s: r.s, // ชื่อโครงการ
        d: r.d, // นักวิจัย
        f: r.f, // คณะ
        g: r.g, // งบประมาณ
        h: r.h, // แหล่งทุน
        j: r.j, // หน่วยงานทุน
        k: r.k, // ประเภท
        l: r.l, // สถานะ
        z: r.z  // วันสิ้นสุด
      });

      log(`Sending Row ${i + 1}: ${r.s.substring(0, 40)}...`);

      // 1. เช็คก่อน sleep
      console.log("Debug :: 1. Start Sleep");
      await sleep(10000 * i);
      console.log("Debug :: 2. End Sleep / Preparing to call lineNotifyAdd");

      // 2. เช็คก่อนเข้า lineNotifyAdd
      // เดาว่า Error น่าจะเกิด 'ภายใน' ฟังก์ชันนี้ หรือไม่ก็ตอนเรียกใช้มัน
      try {
        await lineNotifyAdd(encodeURI(payload));
        console.log("Debug :: 3. lineNotifyAdd Success");
      } catch (err) {
        console.error("Debug :: lineNotifyAdd Failed:", err);
      }
    }

    // รีเซ็ตตัวนับ login failed เมื่อสำเร็จ
    state.loginAttempt = 0;

  } catch (err) {
    log("mainStart error: " + (err?.message || err));
    await sleep(RETRY_DELAY_MINUTES * 60 * 1000);
    await autoLoginNRIIS();

  } finally {
    state.isRunning = false;
  }
}

/**
 * queryProposalListViaDOM (New Version)
 * สร้าง Tab, รอโหลดเสร็จ, ใช้ DOM Scripting แกะข้อมูล, ปิด Tab
 */
async function queryProposalListViaDOM() {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url: NRIIS_LIST, active: false }, (tab) => {
      if (!tab || !tab.id) return reject(new Error("Cannot create tab for ProposalList"));

      // ตัวดักฟังว่า Tab โหลดเสร็จหรือยัง
      const listener = (tabId, changeInfo, tabInfo) => {
        if (tabId === tab.id && changeInfo.status === 'complete') {
          // ลบ Listener ออกเพื่อไม่ให้รันซ้ำ
          chrome.tabs.onUpdated.removeListener(listener);

          // ยิง Script เข้าไปแกะข้อมูล
          chrome.scripting.executeScript(
            {
              target: { tabId: tab.id },
              func: () => {
                try {
                  // --- 1. ดึงตัวเลขจำนวน ---
                  const span = document.querySelector("#ctl00_ContentDetail_lbN");
                  let count = 0;
                  if (span) {
                    // หาตัวเลขจากข้อความ เช่น "รอการพิจารณา 1 โครงการ"
                    const match = (span.textContent || "").match(/(\d+)/);
                    if (match) count = Number(match[0]);
                  }

                  // --- 2. ดึงตารางข้อมูล ---
                  const table = document.querySelector("#ctl00_ContentDetail_gv_wait");
                  const extractedRows = [];

                  if (table) {
                    const trs = table.querySelectorAll("tr");
                    // เริ่ม i=1 เพราะแถวแรก (0) คือ Header
                    for (let i = 1; i < trs.length; i++) {
                      const tds = trs[i].querySelectorAll("td");
                      // ปกติต้องมีประมาณ 10 columns
                      if (tds.length < 9) continue;

                      // --- [จุดที่แก้ 1] ดึงรหัส (Column 0) ---
                      const id = tds[0].innerText.trim();

                      // Column 2: มีทั้ง ชื่อ, นักวิจัย, คณะ ปนกัน
                      const rawTextCol2 = tds[2].innerText || "";

                      // หาชื่อโครงการ (เอาจาก <a> ดีที่สุด)
                      const title = tds[2].querySelector("a")?.innerText.trim() || "";

                      // หานักวิจัย
                      let researcher = "";
                      const resMatch = rawTextCol2.match(/นักวิจัย\s*:\s*(.*)/);
                      // ดึงข้อความจนจบบรรทัด หรือจนเจอคำว่า "คณะ" (ถ้ามันติดกัน)
                      if (resMatch) {
                        // ตัดคำว่า "คณะ" ออก ถ้ามันหลุดติดมาด้วย
                        let temp = resMatch[1].trim();
                        researcher = temp.split("คณะ")[0].trim();
                      }

                      // หาคณะ
                      let faculty = "";
                      const facMatch = rawTextCol2.match(/คณะ(.*)/);
                      if (facMatch) faculty = facMatch[1].trim();

                      // หาข้อมูลวันสิ้นสุด (Column 9)
                      const deadLineSpan = tds[9].querySelector("span[id*='lbHAEnddate']");
                      const deadLine = deadLineSpan ? deadLineSpan.innerText.trim() : "";

                      // --- [จุดที่แก้ 2] เรียง key ให้ตรงกับ Excel ---
                      // s=รหัส, d=ชื่อโครงการ, f=หัวหน้าโครงการ, g=คณะ, h=งบ, j=แหล่งทุน...
                      extractedRows.push({
                        s: id,                      // แก้: เอาตัวแปร id มาใส่ช่อง s (รหัส)
                        d: title,                   // แก้: เอา title มาใส่ช่อง d (ชื่อโครงการ)
                        f: researcher,              // แก้: เอา researcher มาใส่ช่อง f (หัวหน้าโครงการ)
                        g: faculty,                 // แก้: เอา faculty มาใส่ช่อง g (คณะ)
                        h: tds[3].innerText.trim(), // เลื่อน: งบเสนอขอ ไปช่อง h
                        j: tds[4].innerText.trim(), // เลื่อน: แหล่งทุน ไปช่อง j
                        k: tds[5].innerText.trim(), // เลื่อน: หน่วยงาน ไปช่อง k
                        l: tds[6].innerText.trim(), // เลื่อน: ประเภท ไปช่อง l
                        z: deadLine                 // วันสิ้นสุด
                      });
                    }
                  }

                  return { count, dataRows: extractedRows };

                } catch (e) {
                  return { count: 0, dataRows: [], error: e.message };
                }
              }
            },
            (results) => {
              // ปิด Tab เสร็จงาน
              chrome.tabs.remove(tab.id);

              const res = results?.[0]?.result;
              if (!res) return reject(new Error("No result from injected script"));
              resolve(res);
            }
          );
        }
      };

      // เริ่มดักฟัง
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

// ---------- Helper: Test Access ----------
async function testAccessProposalList() {
  const testUrl = `${NRIIS_BASE}/ProposalListAgree.aspx`;
  return new Promise((resolve) => {
    chrome.tabs.create({ url: testUrl, active: false }, (tab) => {
      if (!tab || !tab.id) return resolve({ ok: false, error: "cannot create tab" });

      // ใช้ onUpdated รอโหลดเสร็จเหมือนกัน เพื่อความชัวร์
      const listener = (tabId, changeInfo) => {
        if (tabId === tab.id && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              const href = location.href;
              // ตรวจว่าอยู่หน้า Login หรือไม่? (ถ้าเด้งไปหน้า Login แสดงว่า Session หลุด)
              const isLoginPage = href.toLowerCase().includes("login.aspx");
              // ตรวจว่าเจอ Element หลักไหม
              const hasTable = !!document.querySelector("#ctl00_ContentDetail_gv_wait");
              const hasCount = !!document.querySelector("#ctl00_ContentDetail_lbN");

              return { isLoginPage, hasTable, hasCount, href };
            }
          }, (results) => {
            chrome.tabs.remove(tab.id);
            const res = results?.[0]?.result;

            if (res && !res.isLoginPage && (res.hasTable || res.hasCount)) {
              resolve({ ok: true, details: res });
            } else {
              resolve({ ok: false, details: res });
            }
          });
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

// ---------- Login Helper ----------
async function autoLoginNRIIS() {
  state.loginAttempt++;
  if (state.loginAttempt > MAX_LOGIN_RETRY) {
    await lineNotifyError(`${NAME_PREFIX}Error : เข้าสู่ระบบ NRIIS ไม่ได้... กรุณาตรวจสอบ`);
    return;
  }

  const { username, password } = await getCredentials();
  if (!username || !password) {
    log("No credentials configured. Open options page.");
    return;
  }

  return new Promise((resolve) => {
    chrome.tabs.create({ url: NRIIS_LOGIN, active: false }, (tab) => {
      if (!tab?.id) return resolve();

      const listener = (tabId, changeInfo) => {
        if (tabId === tab.id && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          chrome.scripting.executeScript(
            {
              target: { tabId: tab.id },
              func: (u, p) => {
                try {
                  const r2 = document.getElementById("ctl00_ContentDetail_gridRadios2");
                  if (r2) r2.checked = true;
                  const ut = document.getElementById("ctl00_ContentDetail_tb_user");
                  const pw = document.getElementById("ctl00_ContentDetail_tb_password");
                  const bt = document.getElementById("ctl00_ContentDetail_bt_login");
                  if (ut) ut.value = u;
                  if (pw) pw.value = p;
                  if (bt) bt.click();
                } catch (e) { }
              },
              args: [username, password]
            },
            () => {
              // รอ 5 วินาทีหลังกดปุ่ม Login เพื่อให้ Redirect ทำงาน
              setTimeout(async () => {
                if (tab?.id) chrome.tabs.remove(tab.id);
                // ลองเริ่ม mainStart ใหม่อีกครั้ง
                await mainStart();
                resolve();
              }, 5000);
            }
          );
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

// ---------- LINE notify via Apps Script ----------
async function lineNotifyAdd(d) {
  await openTempPopup(`${G_SCRIPT}?a=addData&d=${d}`);
}

async function lineNotifyError(d) {
  await openTempPopup(`${G_SCRIPT}?er=${encodeURIComponent(d)}`);
}

async function openTempPopup(url) {
  return new Promise((resolve) => {
    chrome.windows.create(
      {
        url,
        incognito: true,
        type: "popup",      // กลับมาใช้ popup เหมือนเดิม
        width: 10,          // กำหนดขนาดให้เล็กที่สุด
        height: 10,
        left: 0,
        top: 0,
        focused: false      // <-- ใช้คำสั่งนี้แทน: สั่งให้หน้าต่างไปอยู่ข้างหลัง ไม่แย่งเมาส์/คีย์บอร์ด
        // state: 'minimized'  <-- ลบบรรทัดนี้ทิ้งเลยครับ คือตัวปัญหา
      },
      (win) => {
        // ยังคงเก็บตัวดัก Error ไว้ กันเหนียวครับ
        if (chrome.runtime.lastError) {
          console.warn("Comet :: Popup Error:", chrome.runtime.lastError.message);
          return resolve();
        }

        if (!win?.id) return resolve();

        // รอ 5 วินาทีเพื่อให้ Script ทำงาน แล้วค่อยปิด
        setTimeout(() => {
          chrome.windows.remove(win.id, () => resolve());
        }, 5000);
      }
    );
  });
}

// ---------- Badges / Notifications ----------
function setBadge(n) {
  // Debug ดูค่า (เก็บไว้ดูได้ครับ มีประโยชน์)
  console.log("Comet :: Debug :: setBadge called with:", n);

  // เตรียมค่า Text
  let textVal = (n === undefined || n === null) ? "" : String(n);

  // เตรียมค่า Color
  // หมายเหตุ: ใช้สีพื้นฐาน Hex Code ชัวร์ที่สุด
  let colorVal = (n === 0 || n === "0") ? "#000000" : "#FF0000";

  // 1. ตั้งค่า Text (พร้อมตัวดัก Error)
  chrome.action.setBadgeText({ text: textVal }, () => {
    if (chrome.runtime.lastError) {
      // แค่เตือนใน Console สีเหลือง ไม่ให้แดง
      console.warn("Comet :: Badge Text Warning:", chrome.runtime.lastError.message);
    }
  });

  // 2. ตั้งค่า Color (พร้อมตัวดัก Error <-- เพิ่มตรงนี้ครับ)
  chrome.action.setBadgeBackgroundColor({ color: colorVal }, () => {
    if (chrome.runtime.lastError) {
      // แค่เตือนใน Console สีเหลือง ไม่ให้แดง
      console.warn("Comet :: Badge Color Warning:", chrome.runtime.lastError.message);
    }
  });
}

function createNotification(count) {
  const iconUrl = chrome.runtime.getURL("js/images/nriis-logo.png");
  chrome.notifications.create("NRIIS_NOTI", {
    type: "basic",
    iconUrl,
    title: `${NAME_PREFIX}NRIIS ตรวจสอบ/รับรองฯ ทุนภายนอก`,
    message: `มีโครงการวิจัยที่รอการพิจารณา จำนวน ${count} โครงการ`,
    priority: 2
  });
}

// ---------- Storage & Cookies ----------
async function getCredentials() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ username: "", password: "" }, (items) => {
      resolve({ username: items.username, password: items.password });
    });
  });
}
async function getCookieValue(domain, name) {
  return new Promise((resolve) => {
    chrome.cookies.get({ url: domain, name }, (cookie) => {
      resolve(cookie?.value || "");
    });
  });
}

// ---------- Utils ----------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg) { console.log(`${NAME_PREFIX}${new Date().toLocaleString("th-TH")} : ${msg}`); }