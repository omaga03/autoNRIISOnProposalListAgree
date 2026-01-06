// js/options.js

// 1. โหลดค่าเดิมมาแสดง
document.addEventListener('DOMContentLoaded', () => {
    chrome.storage.sync.get({ username: '', password: '' }, (items) => {
        document.getElementById('username').value = items.username;
        document.getElementById('password').value = items.password;
    });

    setupPasswordToggle(); // เรียกฟังก์ชันปุ่มตา
});

// 2. บันทึกค่าเมื่อกดปุ่ม
document.getElementById('saveBtn').addEventListener('click', () => {
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value.trim();

    chrome.storage.sync.set({ username, password }, () => {
        // แสดงข้อความว่าบันทึกแล้ว (Fade In)
        const status = document.getElementById('saved');
        status.classList.add('show');

        // ซ่อนข้อความหลังผ่านไป 2 วินาที (Fade Out)
        setTimeout(() => {
            status.classList.remove('show');
        }, 2000);
    });
});

// 3. ฟังก์ชันจัดการปุ่มดูรหัสผ่าน
function setupPasswordToggle() {
    const toggleBtn = document.getElementById('togglePassword');
    const passwordInput = document.getElementById('password');
    const eyeIcon = document.getElementById('eyeIcon');
    const eyeOffIcon = document.getElementById('eyeOffIcon');

    if (toggleBtn && passwordInput) {
        toggleBtn.addEventListener('click', () => {
            // สลับ type
            const isPassword = passwordInput.getAttribute('type') === 'password';
            passwordInput.setAttribute('type', isPassword ? 'text' : 'password');

            // สลับไอคอน
            if (isPassword) {
                eyeIcon.classList.add('hidden');
                eyeOffIcon.classList.remove('hidden');
            } else {
                eyeIcon.classList.remove('hidden');
                eyeOffIcon.classList.add('hidden');
            }
        });
    }
}
