// app.js - single entry that boots either the login or dashboard logic
import { initLogin } from "./auth.js";
import { initApp } from "./main.js";

function boot() {
    const role = localStorage.getItem("userRole");
    const isLoginPage = !!document.getElementById("loginBtn");

    // New dashboard detection logic
    const isDashboardPage = document.querySelector(".tab") && document.querySelector("#combinedChart");

    // Already logged in but on login page → redirect
    if (role && isLoginPage) {
        window.location.href = "dashboard.html";
        return;
    }

    // On login page
    if (isLoginPage) {
        initLogin();
        return;
    }

    // On dashboard
    if (isDashboardPage) {
        initApp();
        return;
    }
}

document.addEventListener("DOMContentLoaded", boot);