// Menyiapkan Chromium milik Playwright agar ikut dibundel ke installer
// (electron-builder extraResources: vendor/chromium -> resources/chromium).
// Dijalankan di OS yang sama dengan target build (Windows untuk .exe,
// Linux untuk .deb/.rpm), karena binary Chromium berbeda tiap OS.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const downloadDir = path.join(root, "vendor", "pw-browsers");
const outputDir = path.join(root, "vendor", "chromium");

fs.rmSync(downloadDir, { recursive: true, force: true });
fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(downloadDir, { recursive: true });

console.log("Mengunduh Chromium Playwright ke", downloadDir);
execFileSync(
  process.execPath,
  [require.resolve("playwright/cli"), "install", "--no-shell", "chromium"],
  {
    stdio: "inherit",
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: downloadDir },
  },
);

const revisionDir = fs
  .readdirSync(downloadDir)
  .find((name) => /^chromium-\d+$/.test(name));
if (!revisionDir) {
  throw new Error(`Folder chromium-<revisi> tidak ditemukan di ${downloadDir}`);
}

fs.cpSync(path.join(downloadDir, revisionDir), outputDir, { recursive: true });

// Cari executable dan pastikan lokasinya sama dengan yang dicari aplikasi
// (lihat findBundledChromium di desktop/services/automation.js).
const expected =
  process.platform === "win32"
    ? ["chrome-win64/chrome.exe", "chrome-win/chrome.exe"]
    : ["chrome-linux64/chrome", "chrome-linux/chrome"];
const found = expected.find((relative) =>
  fs.existsSync(path.join(outputDir, relative)),
);
if (!found) {
  console.error("Isi vendor/chromium:", fs.readdirSync(outputDir));
  throw new Error(
    `Executable Chromium tidak ada di lokasi yang dicari aplikasi: ${expected.join(", ")}`,
  );
}
if (process.platform !== "win32") {
  fs.chmodSync(path.join(outputDir, found), 0o755);
}

fs.rmSync(downloadDir, { recursive: true, force: true });
console.log("Chromium siap dibundel:", found);
