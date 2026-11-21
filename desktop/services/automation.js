import { chromium } from "playwright";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { EventEmitter } from "events";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { spawn } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Anti-detection: randomised browser identity per session
// ---------------------------------------------------------------------------

const DESKTOP_USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
];

const WEBGL_VENDORS = [
  "Google Inc. (NVIDIA)",
  "Google Inc. (AMD)",
  "Google Inc. (Intel)",
];

const WEBGL_RENDERERS = [
  "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)",
  "ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  "ANGLE (AMD, AMD Radeon RX 5700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)",
];

const SCREEN_RESOLUTIONS = [
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
];

const LOCALES = ["id-ID", "en-US", "en-GB"];
const TIMEZONES = [
  "Asia/Jakarta",
  "Asia/Makassar",
  "Asia/Jayapura",
  "America/New_York",
];

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ---------------------------------------------------------------------------
// Spintax & Anti-Duplicate Content Engine
// Mengacak teks dengan format {opsi1|opsi2|opsi3} & menambah entropi tak terlihat
// ---------------------------------------------------------------------------

function parseSpintax(text) {
  if (!text) return "";
  let result = String(text);
  const regex = /\{([^{}]+)\}/;
  let match;
  while ((match = regex.exec(result)) !== null) {
    const choices = match[1].split("|");
    const chosen = choices[Math.floor(Math.random() * choices.length)];
    result = result.slice(0, match.index) + chosen + result.slice(match.index + match[0].length);
  }
  return result;
}

function addZeroWidthEntropy(text) {
  if (!text) return text;
  // Sisipkan 2-5 karakter zero-width tak terlihat di akhir teks agar hash teks unik di Facebook
  const invisibleChars = ["\u200B", "\u200C", "\u200D", "\uFEFF"];
  let entropy = "";
  const count = 2 + Math.floor(Math.random() * 4);
  for (let i = 0; i < count; i++) {
    entropy += invisibleChars[Math.floor(Math.random() * invisibleChars.length)];
  }
  return text + entropy;
}

// Script yang di-inject SEBELUM halaman apapun dimuat.  Menutupi SEMUA
// signal yang dipakai Facebook untuk mendeteksi browser automation — termasuk
// layer agresif: CDP leak, AudioContext, font enumeration, iframe, Notification
// constructor, stack trace inspection, dan event timing.
function buildStealthScript({
  webglVendor, webglRenderer, hardwareConcurrency, deviceMemory,
  canvasNoise, audioNoise,
}) {
  return `
    // ===== LAYER 1: Core automation flags ===================================

    // 1a. navigator.webdriver — sinyal utama Playwright/Selenium/Puppeteer
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });
    // Hapus juga dari prototype chain
    delete Object.getPrototypeOf(navigator).webdriver;

    // 1b. Automation flags lain yang dipakai Facebook
    for (const prop of [
      'domAutomation', 'domAutomationController', '_phantom',
      '__nightmare', '_selenium', 'callPhantom', '__webdriver_evaluate',
      '__selenium_evaluate', '__webdriver_script_function',
      '__webdriver_script_func', '__webdriver_script_fn',
      '__fxdriver_evaluate', '__driver_unwrapped', '__webdriver_unwrapped',
      '__driver_evaluate', '__selenium_unwrapped', '_Selenium_IDE_Recorder',
      'calledSelenium', '_WEBDRIVER_ELEM_CACHE', 'ChromeDriverw',
      'driver-hierarchical', 'driver-evaluate', 'webdriver-hierarchical',
    ]) {
      try { delete window[prop]; } catch {}
      try {
        Object.defineProperty(window, prop, {
          get: () => undefined,
          set: () => {},
          configurable: true,
        });
      } catch {}
    }

    // ===== LAYER 2: Chrome environment ======================================

    // 2a. window.chrome — browser sungguhan punya objek ini lengkap
    if (!window.chrome) {
      window.chrome = {};
    }
    window.chrome.runtime = window.chrome.runtime || {
      PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
      PlatformArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
      PlatformNaclArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
      RequestUpdateCheckStatus: { THROTTLED: 'throttled', NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available' },
      OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
      OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
      connect: () => { throw new Error('Could not establish connection.'); },
      sendMessage: () => { throw new Error('Could not establish connection.'); },
    };
    window.chrome.loadTimes = window.chrome.loadTimes || function () {
      return {
        commitLoadTime: Date.now() / 1000 - 2.5,
        connectionInfo: 'h2',
        finishDocumentLoadTime: Date.now() / 1000 - 0.4,
        finishLoadTime: Date.now() / 1000 - 0.1,
        firstPaintAfterLoadTime: 0,
        firstPaintTime: Date.now() / 1000 - 1.8,
        navigationType: 'Other',
        npnNegotiatedProtocol: 'h2',
        requestTime: Date.now() / 1000 - 3.0,
        startLoadTime: Date.now() / 1000 - 2.8,
        wasAlternateProtocolAvailable: false,
        wasFetchedViaSpdy: true,
        wasNpnNegotiated: true,
      };
    };
    window.chrome.csi = window.chrome.csi || function () {
      return {
        onloadT: Date.now(),
        startE: Date.now() - 1200,
        pageT: 3200 + Math.random() * 800,
        tran: 15,
      };
    };

    // ===== LAYER 3: Permissions API =========================================

    const originalQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) => {
        if (parameters.name === 'notifications') {
          return Promise.resolve({ state: Notification.permission });
        }
        return originalQuery(parameters);
      };
    }

    // ===== LAYER 4: Navigator properties ====================================

    // 4a. Plugins — browser biasa punya >= 3 plugin; Playwright punya 0
    const fakePlugins = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 2 },
    ];
    fakePlugins.refresh = () => {};
    fakePlugins.item = (i) => fakePlugins[i] || null;
    fakePlugins.namedItem = (n) => fakePlugins.find(p => p.name === n) || null;
    Object.defineProperty(navigator, 'plugins', { get: () => fakePlugins });

    // 4b. MimeTypes — konsisten dengan plugins
    const fakeMimeTypes = [
      { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: fakePlugins[0] },
      { type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable', enabledPlugin: fakePlugins[2] },
      { type: 'application/x-pnacl', suffixes: '', description: 'Portable Native Client Executable', enabledPlugin: fakePlugins[2] },
    ];
    fakeMimeTypes.item = (i) => fakeMimeTypes[i] || null;
    fakeMimeTypes.namedItem = (n) => fakeMimeTypes.find(m => m.type === n) || null;
    Object.defineProperty(navigator, 'mimeTypes', { get: () => fakeMimeTypes });

    // 4c. Languages — pastikan konsisten
    Object.defineProperty(navigator, 'languages', {
      get: () => ['id-ID', 'id', 'en-US', 'en'],
    });

    // 4d. Hardware concurrency & device memory — randomised per sesi
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => ${hardwareConcurrency},
    });
    Object.defineProperty(navigator, 'deviceMemory', {
      get: () => ${deviceMemory},
    });

    // 4e. maxTouchPoints — desktop tidak punya touch
    Object.defineProperty(navigator, 'maxTouchPoints', {
      get: () => 0,
    });

    // 4f. connection — browser biasa punya NetworkInformation
    if (!navigator.connection) {
      Object.defineProperty(navigator, 'connection', {
        get: () => ({
          effectiveType: '4g',
          rtt: ${pickRandom([50, 100, 150])},
          downlink: ${pickRandom([1.5, 2.5, 5, 10])},
          saveData: false,
        }),
      });
    }

    // ===== LAYER 5: WebGL fingerprint =======================================

    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (param) {
      if (param === 37445) return '${webglVendor}';    // UNMASKED_VENDOR
      if (param === 37446) return '${webglRenderer}';  // UNMASKED_RENDERER
      return getParameter.call(this, param);
    };
    const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function (param) {
      if (param === 37445) return '${webglVendor}';
      if (param === 37446) return '${webglRenderer}';
      return getParameter2.call(this, param);
    };

    // Juga override getExtension untuk WEBGL_debug_renderer_info
    const origGetExt = WebGLRenderingContext.prototype.getExtension;
    WebGLRenderingContext.prototype.getExtension = function (name) {
      if (name === 'WEBGL_debug_renderer_info') {
        return { UNMASKED_VENDOR_WEBGL: 37445, UNMASKED_RENDERER_WEBGL: 37446 };
      }
      return origGetExt.call(this, name);
    };

    // ===== LAYER 6: Canvas fingerprint ======================================

    // 6a. toDataURL — noise minimal supaya hash berubah tiap sesi
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (type) {
      if (this.width === 0 && this.height === 0) return originalToDataURL.apply(this, arguments);
      const ctx = this.getContext('2d');
      if (ctx) {
        const style = ctx.fillStyle;
        ctx.fillStyle = 'rgba(${canvasNoise[0]},${canvasNoise[1]},${canvasNoise[2]},0.01)';
        ctx.fillRect(0, 0, 1, 1);
        ctx.fillStyle = style;
      }
      return originalToDataURL.apply(this, arguments);
    };

    // 6b. toBlob — Facebook juga pakai toBlob untuk canvas fingerprint
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      if (this.width > 0 && this.height > 0) {
        const ctx = this.getContext('2d');
        if (ctx) {
          const style = ctx.fillStyle;
          ctx.fillStyle = 'rgba(${canvasNoise[0]},${canvasNoise[2]},${canvasNoise[1]},0.01)';
          ctx.fillRect(0, 0, 1, 1);
          ctx.fillStyle = style;
        }
      }
      return originalToBlob.call(this, callback, type, quality);
    };

    // 6c. getImageData — lapisan ketiga canvas fingerprint
    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (sx, sy, sw, sh) {
      const imageData = origGetImageData.call(this, sx, sy, sw, sh);
      // Flip 1 byte per 512 pixels — invisible tapi hash pasti berubah
      for (let i = 0; i < imageData.data.length; i += 2048) {
        imageData.data[i] = imageData.data[i] ^ 1;
      }
      return imageData;
    };

    // ===== LAYER 7: AudioContext fingerprint =================================

    const origGetFloatFreq = AnalyserNode.prototype.getFloatFrequencyData;
    AnalyserNode.prototype.getFloatFrequencyData = function (array) {
      origGetFloatFreq.call(this, array);
      // Noise kecil di frekuensi data — mengubah hash audio fingerprint
      for (let i = 0; i < array.length; i += 7) {
        array[i] += ${audioNoise} * (Math.random() - 0.5);
      }
    };

    const origCreateOscillator = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () {
      const osc = origCreateOscillator.call(this);
      const origConnect = osc.connect.bind(osc);
      osc.connect = function (dest) {
        // Kalau tujuannya AnalyserNode, tambahkan gain node kecil di tengah
        // supaya hash sedikit berbeda
        if (dest instanceof AnalyserNode) {
          try {
            const gain = osc.context.createGain();
            gain.gain.value = 1 + ${audioNoise} * 0.00001;
            origConnect(gain);
            gain.connect(dest);
            return dest;
          } catch { /* fallback */ }
        }
        return origConnect(dest);
      };
      return osc;
    };

    // OfflineAudioContext juga
    if (typeof OfflineAudioContext !== 'undefined') {
      const origOffOsc = OfflineAudioContext.prototype.createOscillator;
      OfflineAudioContext.prototype.createOscillator = function () {
        const osc = origOffOsc.call(this);
        const origConnect = osc.connect.bind(osc);
        osc.connect = function (dest) {
          if (dest instanceof AnalyserNode) {
            try {
              const gain = osc.context.createGain();
              gain.gain.value = 1 + ${audioNoise} * 0.00001;
              origConnect(gain);
              gain.connect(dest);
              return dest;
            } catch {}
          }
          return origConnect(dest);
        };
        return osc;
      };
    }

    // ===== LAYER 8: CDP / DevTools detection =================================

    // 8a. Error stack trace — Facebook mengecek nama file di stack trace
    //     untuk menemukan 'pptr:' atau 'puppeteer' atau 'playwright'
    const origStackDescriptor = Object.getOwnPropertyDescriptor(Error.prototype, 'stack');
    if (origStackDescriptor && origStackDescriptor.get) {
      Object.defineProperty(Error.prototype, 'stack', {
        get() {
          const stack = origStackDescriptor.get.call(this);
          if (typeof stack !== 'string') return stack;
          return stack
            .replace(/pptr:/g, 'chrome-extension://')
            .replace(/playwright/gi, 'chrome')
            .replace(/puppeteer/gi, 'chrome');
        },
        configurable: true,
      });
    }

    // 8b. Debugger detection — Facebook pakai (function(){}).constructor
    //     untuk memeriksa apakah debugger aktif
    //     Kita tidak override Function constructor (Facebook sendiri pakai),
    //     tapi kita override performance.now timing yang dipakai untuk
    //     timing-based debugger detection
    const origPerfNow = performance.now.bind(performance);
    let lastPerfNow = origPerfNow();
    performance.now = function () {
      const real = origPerfNow();
      // Kalau gap terlalu besar (debugger pause), compress
      if (real - lastPerfNow > 100) {
        lastPerfNow = real;
      }
      lastPerfNow = real;
      return real;
    };

    // ===== LAYER 9: iframe contentWindow ====================================

    // Playwright bocor di cross-origin iframe: contentWindow.chrome undefined,
    // dan beberapa property missing.  Override HTMLIFrameElement.prototype
    const origContentWindow = Object.getOwnPropertyDescriptor(
      HTMLIFrameElement.prototype, 'contentWindow'
    );
    if (origContentWindow) {
      Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
        get() {
          const win = origContentWindow.get.call(this);
          if (!win) return win;
          try {
            // Hanya bisa akses same-origin iframe
            if (win.chrome === undefined) {
              win.chrome = { runtime: {} };
            }
          } catch {
            // Cross-origin — ignore, tidak bisa diakses
          }
          return win;
        },
        configurable: true,
      });
    }

    // ===== LAYER 10: Notification constructor ================================

    // Facebook cek apakah Notification.toString() normal
    const origNotification = window.Notification;
    if (origNotification) {
      const fakeNotification = function (title, options) {
        return new origNotification(title, options);
      };
      fakeNotification.permission = origNotification.permission;
      fakeNotification.requestPermission = origNotification.requestPermission?.bind(origNotification);
      fakeNotification.prototype = origNotification.prototype;
      Object.defineProperty(fakeNotification, 'name', { value: 'Notification' });
      Object.defineProperty(fakeNotification, 'toString', {
        value: () => 'function Notification() { [native code] }',
      });
      window.Notification = fakeNotification;
    }

    // ===== LAYER 11: toString / prototype spoofing ===========================

    // Facebook cek apakah fungsi yang di-override punya toString normal
    const origToString = Function.prototype.toString;
    const spoofedFunctions = new Set();

    function spoofToString(fn, nativeName) {
      spoofedFunctions.add(fn);
      fn.toString = function () {
        if (spoofedFunctions.has(this)) {
          return 'function ' + nativeName + '() { [native code] }';
        }
        return origToString.call(this);
      };
    }

    // Spoof semua fungsi yang sudah kita override
    spoofToString(navigator.permissions.query, 'query');
    spoofToString(WebGLRenderingContext.prototype.getParameter, 'getParameter');
    spoofToString(WebGL2RenderingContext.prototype.getParameter, 'getParameter');
    spoofToString(WebGLRenderingContext.prototype.getExtension, 'getExtension');
    spoofToString(HTMLCanvasElement.prototype.toDataURL, 'toDataURL');
    spoofToString(HTMLCanvasElement.prototype.toBlob, 'toBlob');
    spoofToString(CanvasRenderingContext2D.prototype.getImageData, 'getImageData');
    spoofToString(AnalyserNode.prototype.getFloatFrequencyData, 'getFloatFrequencyData');
    spoofToString(performance.now, 'now');
  `;
}

const MARKETPLACE_CATEGORIES = {
  home_garden: {
    label: "Rumah & Taman",
    aliases: ["Rumah & Taman", "Rumah dan Taman", "Home & Garden"],
    subcategories: {
      equipment: {
        label: "Peralatan",
        aliases: ["Peralatan", "Equipment"],
      },
      furniture: {
        label: "Mebel",
        aliases: ["Mebel", "Furniture"],
      },
      home_appliances: {
        label: "Peralatan Rumah Tangga",
        aliases: ["Peralatan Rumah Tangga", "Home appliances"],
      },
      garden: {
        label: "Kebun",
        aliases: ["Kebun", "Garden"],
      },
      tools: {
        label: "Perkakas",
        aliases: ["Perkakas", "Tools"],
      },
    },
  },

  entertainment: {
    label: "Hiburan",
    aliases: ["Hiburan", "Entertainment"],
    subcategories: {
      video_games: {
        label: "Video Game",
        aliases: ["Video Game", "Video Games"],
      },
      books: {
        label: "Buku",
        aliases: ["Buku", "Books"],
      },
      films: {
        label: "Film",
        aliases: ["Film", "Films", "Movies"],
      },
      music: {
        label: "Musik",
        aliases: ["Musik", "Music"],
      },
    },
  },

  clothing_accessories: {
    label: "Pakaian & Aksesori",
    aliases: [
      "Pakaian & Aksesori",
      "Pakaian dan Aksesori",
      "Clothing & Accessories",
    ],
    subcategories: {
      bags_luggage: {
        label: "Tas & Koper",
        aliases: ["Tas & Koper", "Tas dan Koper", "Bags & Luggage"],
      },
      women_clothing_shoes: {
        label: "Pakaian & Sepatu Wanita",
        aliases: [
          "Pakaian & Sepatu Wanita",
          "Pakaian dan Sepatu Wanita",
          "Women's Clothing & Shoes",
        ],
      },
      men_clothing_shoes: {
        label: "Pakaian & Sepatu Pria",
        aliases: [
          "Pakaian & Sepatu Pria",
          "Pakaian dan Sepatu Pria",
          "Men's Clothing & Shoes",
        ],
      },
      jewelry_accessories: {
        label: "Perhiasan & Aksesori",
        aliases: [
          "Perhiasan & Aksesori",
          "Perhiasan dan Aksesori",
          "Jewelry & Accessories",
        ],
      },
    },
  },

  family: {
    label: "Keluarga",
    aliases: ["Keluarga", "Family"],
    subcategories: {
      health_beauty: {
        label: "Kesehatan & Kecantikan",
        aliases: [
          "Kesehatan & Kecantikan",
          "Kesehatan dan Kecantikan",
          "Health & Beauty",
        ],
      },
      pet_supplies: {
        label: "Kebutuhan Hewan Peliharaan",
        aliases: ["Kebutuhan Hewan Peliharaan", "Pet Supplies"],
      },
      baby_children: {
        label: "Bayi & Anak-anak",
        aliases: ["Bayi & Anak-anak", "Bayi dan Anak-anak", "Baby & Kids"],
      },
      toys_games: {
        label: "Mainan & Game",
        aliases: ["Mainan & Game", "Mainan dan Game", "Toys & Games"],
      },
    },
  },

  electronics: {
    label: "Elektronik",
    aliases: ["Elektronik", "Electronics"],
    subcategories: {
      electronics_computers: {
        label: "Elektronik & Komputer",
        aliases: [
          "Elektronik & Komputer",
          "Elektronik dan Komputer",
          "Electronics & Computers",
        ],
      },
      mobile_phones: {
        label: "Telepon Seluler",
        aliases: ["Telepon Seluler", "Ponsel", "Mobile Phones", "Cell Phones"],
      },
    },
  },

  hobbies: {
    label: "Hobi",
    aliases: ["Hobi", "Hobbies"],
    subcategories: {
      bicycles: {
        label: "Sepeda",
        aliases: ["Sepeda", "Bicycles"],
      },
      arts_crafts: {
        label: "Seni & Kerajinan",
        aliases: ["Seni & Kerajinan", "Seni dan Kerajinan", "Arts & Crafts"],
      },
      sports_outdoors: {
        label: "Olahraga & Outdoor",
        aliases: [
          "Olahraga & Outdoor",
          "Olahraga dan Outdoor",
          "Sports & Outdoors",
        ],
      },
      auto_parts: {
        label: "Komponen Otomotif",
        aliases: ["Komponen Otomotif", "Auto Parts"],
      },
      musical_instruments: {
        label: "Alat Musik",
        aliases: ["Alat Musik", "Musical Instruments"],
      },
      antiques_collectibles: {
        label: "Barang Antik & Koleksi",
        aliases: [
          "Barang Antik & Koleksi",
          "Barang Antik dan Koleksi",
          "Antiques & Collectibles",
        ],
      },
    },
  },

  classifieds: {
    label: "Iklan Baris",
    aliases: ["Iklan Baris", "Classifieds"],
    subcategories: {
      clearance: {
        label: "Cuci Gudang",
        aliases: ["Cuci Gudang", "Clearance"],
      },
      other: {
        label: "Lain-lain",
        aliases: ["Lain-lain", "Lainnya", "Other"],
      },
    },
  },

  vehicles: {
    label: "Kendaraan",
    aliases: ["Kendaraan", "Vehicles"],
    subcategories: {},
  },
};

const MARKETPLACE_CONDITIONS = {
  new: { label: "Baru", aliases: ["Baru", "New"] },
  used_like_new: {
    label: "Bekas — Seperti Baru",
    aliases: [
      "Bekas - Seperti Baru",
      "Bekas — Seperti Baru",
      "Used - Like New",
    ],
  },
  used_good: {
    label: "Bekas — Baik",
    aliases: ["Bekas - Baik", "Bekas — Baik", "Used - Good"],
  },
  used_fair: {
    label: "Bekas — Cukup Baik",
    aliases: ["Bekas - Cukup Baik", "Bekas — Cukup Baik", "Used - Fair"],
  },
  for_parts: {
    label: "Untuk Suku Cadang",
    aliases: ["Untuk Suku Cadang", "For parts or not working"],
  },
};

export class AutomationService extends EventEmitter {
  constructor({ sessionDirectory, closePostedTabs = true, safeStorage = null } = {}) {
    super();
    this.browser = null;
    this.context = null;
    this.page = null;
    // Tab pertama (halaman login). Tab ini sengaja tidak ditutup otomatis
    // supaya jendela browser tetap hidup dan deteksi login tetap berjalan.
    this.mainPage = null;
    // Tutup tab formulir otomatis setelah penerbitan terkonfirmasi.
    this.closePostedTabs = closePostedTabs;
    this.safeStorage = safeStorage;
    // Login cookies are personal data.  Keep them in Electron's per-user
    // data directory instead of the application bundle, which is read-only
    // after installation and may be copied to another computer.
    this.sessionFile = path.join(
      sessionDirectory || path.join(PROJECT_ROOT, "storage"),
      "sessions",
      "default.json",
    );
    this.isLoggedIn = false;
    this.running = false;
    this.stopRequested = false;
    this.manualAction = null;
    this.detectionTimer = null;
    this.browserInstallPromise = null;
  }

  async loadSessionState() {
    try {
      await fs.access(this.sessionFile);
      const raw = await fs.readFile(this.sessionFile);
      if (this.safeStorage?.isEncryptionAvailable?.()) {
        try {
          const decrypted = this.safeStorage.decryptString(raw);
          return JSON.parse(decrypted);
        } catch {
          // Fallback membaca plain JSON jika file sesi dibuat sebelum enkripsi aktif
          return JSON.parse(raw.toString("utf8"));
        }
      }
      return JSON.parse(raw.toString("utf8"));
    } catch {
      return null;
    }
  }

  async saveSessionState() {
    if (!this.context) return;
    try {
      const state = await this.context.storageState();
      const json = JSON.stringify(state);
      await fs.mkdir(path.dirname(this.sessionFile), { recursive: true });
      if (this.safeStorage?.isEncryptionAvailable?.()) {
        const encrypted = this.safeStorage.encryptString(json);
        await fs.writeFile(this.sessionFile, encrypted);
        this.emit("log", "Sesi login berhasil disimpan (terenkripsi DPAPI/SafeStorage).", "info");
      } else {
        await fs.writeFile(this.sessionFile, json, "utf8");
        this.emit("log", "Sesi login berhasil disimpan.", "info");
      }
    } catch (e) {
      console.error("Gagal simpan sesi:", e.message);
    }
  }

  async openBrowser() {
    if (this.browser && this.browser.isConnected()) {
      this.emit("log", "Browser Chromium sudah terbuka.", "info");
      return;
    }

    this.emit("log", "Membuka browser Chromium...", "info");
    this.emit("status", { state: "busy", text: "Membuka browser..." });

    try {
      await fs.mkdir(path.dirname(this.sessionFile), { recursive: true });
      const executablePath = await this.ensureChromiumInstalled();

      this.browser = await chromium.launch({
        headless: false,
        ...(executablePath ? { executablePath } : {}),
        args: [
          "--start-maximized",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-notifications",
          // Anti-detection: sembunyikan semua sinyal automation
          "--disable-blink-features=AutomationControlled",
          "--disable-features=AutomationControlled",
          "--disable-infobars",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--disable-dev-shm-usage",
          // Jangan tampilkan "Chrome is being controlled by automated test software"
          "--disable-component-extensions-with-background-pages",
          "--excludeSwitches=enable-automation",
        ],
        ignoreDefaultArgs: ["--enable-automation"],
      });

      const storageState = await this.loadSessionState();
      if (storageState) {
        this.emit("log", "Menggunakan sesi login tersimpan.", "info");
      } else {
        this.emit(
          "log",
          "Tidak ada sesi tersimpan. Silakan login manual.",
          "info",
        );
      }

      // Identitas browser di-random setiap sesi supaya fingerprint tidak
      // selalu sama dan lebih sulit dikorelasikan oleh Facebook.
      const sessionUA = pickRandom(DESKTOP_USER_AGENTS);
      const sessionLocale = pickRandom(LOCALES);
      const sessionTimezone = pickRandom(TIMEZONES);
      const sessionScreen = pickRandom(SCREEN_RESOLUTIONS);

      this.context = await this.browser.newContext({
        ...(storageState ? { storageState } : {}),
        viewport: null,
        userAgent: sessionUA,
        locale: sessionLocale,
        timezoneId: sessionTimezone,
        screen: sessionScreen,
        colorScheme: "light",
        // Menyembunyikan header Sec-CH-UA yang bocorkan versi Chromium Playwright
        extraHTTPHeaders: {
          "Accept-Language": `${sessionLocale},id;q=0.9,en;q=0.8`,
        },
      });

      // Inject stealth script SEBELUM halaman apapun dimuat
      const stealthParams = {
        webglVendor: pickRandom(WEBGL_VENDORS),
        webglRenderer: pickRandom(WEBGL_RENDERERS),
        hardwareConcurrency: pickRandom([4, 8, 12, 16]),
        deviceMemory: pickRandom([4, 8, 16]),
        canvasNoise: [randomInt(0, 5), randomInt(0, 5), randomInt(0, 5)],
        audioNoise: (Math.random() * 0.0001).toFixed(8),
      };
      await this.context.addInitScript(buildStealthScript(stealthParams));

      this.emit(
        "log",
        `Stealth aktif — UA: ${sessionUA.slice(0, 50)}…, Locale: ${sessionLocale}, TZ: ${sessionTimezone}`,
        "info",
      );

      this.page = await this.context.newPage();
      this.mainPage = this.page;
      this.page.setDefaultTimeout(45000);
      this.page.setDefaultNavigationTimeout(45000);

      this.emit("log", "Mengarahkan ke halaman login Facebook...", "info");
      this.emit("status", { state: "busy", text: "Membuka Facebook..." });
      await this.page.goto("https://www.facebook.com/login", {
        waitUntil: "domcontentloaded",
      });

      this.emit(
        "log",
        "Browser siap. Silakan login manual di jendela Facebook yang terbuka.",
        "warn",
      );
      this.emit("status", { state: "busy", text: "Menunggu login manual..." });

      this.startLoginDetection();
    } catch (err) {
      this.emit("log", `Gagal membuka browser: ${err.message}`, "error");
      this.emit("status", { state: "error", text: "Gagal Buka Browser" });
      await this.close();
      throw err;
    }
  }

  async ensureChromiumInstalled() {
    const bundledExecutable = await this.findBundledChromium();
    if (bundledExecutable) {
      this.emit(
        "log",
        "Menggunakan Chromium yang disertakan bersama aplikasi.",
        "info",
      );
      return bundledExecutable;
    }

    const executablePath = chromium.executablePath();
    try {
      await fs.access(executablePath);
      return null;
    } catch {
      // The Playwright package is present, but its managed browser has not been downloaded yet.
    }

    const cachedExecutable = await this.findCachedChromium();
    if (cachedExecutable) {
      this.emit(
        "log",
        "Menggunakan Chromium Playwright yang sudah tersedia di komputer.",
        "info",
      );
      return cachedExecutable;
    }

    if (!this.browserInstallPromise) {
      this.browserInstallPromise = this.installChromium().finally(() => {
        this.browserInstallPromise = null;
      });
    }
    await this.browserInstallPromise;
    return null;
  }

  async findBundledChromium() {
    // electron-builder puts extraResources beside app.asar. Supplying the
    // browser here makes the installer work on a computer with no Node.js
    // or previously downloaded Playwright browser.
    if (!process.resourcesPath) return null;

    const bundledCandidates =
      process.platform === "win32"
        ? [
            "chromium/chrome-win/chrome.exe",
            "chromium/chrome-win64/chrome.exe",
            "chromium/chrome.exe",
          ]
        : process.platform === "linux"
          ? [
              "chromium/chrome-linux/chrome",
              "chromium/chrome-linux64/chrome",
              "chromium/chrome",
            ]
          : [];

    for (const relativePath of bundledCandidates) {
      const executablePath = path.join(process.resourcesPath, relativePath);
      try {
        await fs.access(executablePath);
        return executablePath;
      } catch {
        // Try next candidate
      }
    }

    // Fallback: pindai folder resources/chromium jika struktur folder berbeda
    try {
      const baseDir = path.join(process.resourcesPath, "chromium");
      const targetName = process.platform === "win32" ? "chrome.exe" : "chrome";
      const scanDir = async (dir, depth = 0) => {
        if (depth > 3) return null;
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isFile() && entry.name.toLowerCase() === targetName.toLowerCase()) {
            return full;
          }
          if (entry.isDirectory()) {
            const found = await scanDir(full, depth + 1);
            if (found) return found;
          }
        }
        return null;
      };
      const found = await scanDir(baseDir);
      if (found) return found;
    } catch {
      // Folder chromium tidak ada di resourcesPath
    }

    return null;
  }

  async findCachedChromium() {
    const cacheRoot = path.join(
      process.env.LOCALAPPDATA || "",
      "ms-playwright",
    );
    if (!process.env.LOCALAPPDATA) return null;

    try {
      const entries = await fs.readdir(cacheRoot, { withFileTypes: true });
      const candidates = entries
        .filter(
          (entry) => entry.isDirectory() && /^chromium-\d+$/.test(entry.name),
        )
        .map((entry) => entry.name)
        .sort((left, right) => Number(right.slice(9)) - Number(left.slice(9)));

      for (const candidate of candidates) {
        for (const relativePath of [
          "chrome-win64/chrome.exe",
          "chrome-win/chrome.exe",
        ]) {
          const executablePath = path.join(cacheRoot, candidate, relativePath);
          try {
            await fs.access(executablePath);
            return executablePath;
          } catch {
            // Try the next executable layout or cached browser revision.
          }
        }
      }
    } catch {
      // No local Playwright cache is available.
    }
    return null;
  }

  async installChromium() {
    this.emit(
      "log",
      "Chromium Playwright belum tersedia. Mengunduh browser otomatis (hanya sekali)...",
      "warn",
    );
    this.emit("status", { state: "busy", text: "Menyiapkan Chromium..." });

    const playwrightPkg = require.resolve("playwright/package.json");
    const playwrightCli = path.join(path.dirname(playwrightPkg), "cli.js");
    await new Promise((resolve, reject) => {
      let installOutput = "";
      const installer = spawn(
        process.execPath,
        [playwrightCli, "install", "chromium"],
        {
          // PROJECT_ROOT berada di dalam app.asar pada aplikasi terpasang,
          // dan folder di dalam asar tidak bisa dipakai sebagai cwd.
          cwd: os.tmpdir(),
          windowsHide: true,
          // When packaged, process.execPath is the application .exe rather
          // than node.exe. This makes Electron run Playwright's CLI as Node.
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        },
      );

      const collectOutput = (chunk) => {
        installOutput = `${installOutput}${chunk}`.slice(-1500);
      };
      installer.stdout.on("data", collectOutput);
      installer.stderr.on("data", collectOutput);
      installer.on("error", reject);
      installer.on("close", (code) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `Unduhan Chromium gagal (kode ${code}). ${installOutput.trim()}`,
            ),
          );
      });
    });

    const executablePath = chromium.executablePath();
    try {
      await fs.access(executablePath);
    } catch {
      throw new Error(
        "Unduhan Chromium selesai, tetapi executable browser tidak ditemukan.",
      );
    }

    this.emit("log", "Chromium Playwright siap digunakan.", "success");
  }

  startLoginDetection() {
    if (this.detectionTimer) clearInterval(this.detectionTimer);

    this.detectionTimer = setInterval(async () => {
      try {
        if (
          !this.browser ||
          !this.browser.isConnected() ||
          !this.page ||
          this.page.isClosed()
        ) {
          clearInterval(this.detectionTimer);
          this.detectionTimer = null;
          return;
        }

        const cookies = await this.context.cookies();
        const hasUser = cookies.some((c) => c.name === "c_user");
        const hasXs = cookies.some((c) => c.name === "xs");

        if (hasUser && hasXs) {
          if (!this.isLoggedIn) {
            this.isLoggedIn = true;
            this.emit(
              "log",
              "Login terdeteksi sukses! Pengguna sudah login ke Facebook.",
              "success",
            );
            this.emit("status", {
              state: "active",
              text: "Sudah Login (Siap Posting)",
            });
            this.emit("login_status", { isLoggedIn: true });

            await this.saveSessionState();
          }
        } else {
          if (this.isLoggedIn) {
            this.isLoggedIn = false;
            this.emit("log", "Sesi terputus. Silakan login kembali.", "warn");
            this.emit("status", { state: "busy", text: "Menunggu login..." });
            this.emit("login_status", { isLoggedIn: false });
          }
        }
      } catch {
        // Ignore transient evaluation errors when page navigates
      }
    }, 2500);
  }

  async checkLoginStatus() {
    if (!this.context || !this.page || this.page.isClosed()) {
      return false;
    }
    try {
      const cookies = await this.context.cookies();
      const hasUser = cookies.some((c) => c.name === "c_user");
      const hasXs = cookies.some((c) => c.name === "xs");
      this.isLoggedIn = hasUser && hasXs;
      return this.isLoggedIn;
    } catch {
      return false;
    }
  }

  async postBatch(payload) {
    if (this.running) {
      throw new Error(
        "Proses posting sedang berjalan. Mohon tunggu hingga selesai.",
      );
    }

    const isLoggedIn = await this.checkLoginStatus();
    if (!isLoggedIn) {
      throw new Error(
        "Belum terdeteksi login. Silakan login manual ke Facebook terlebih dahulu.",
      );
    }

    const listing = await this.validatePayload(payload);
    this.running = true;
    this.stopRequested = false;

    const {
      photoPaths,
      locations,
      title,
      price,
      sku,
      label,
      brand,
      category,
      subcategory,
      condition,
      description,
      loops,
    } = listing;

    const totalPostings = loops * locations.length;

    this.emit("log", "--- MEMULAI BATCH POSTING ---", "info");
    this.emit(
      "log",
      `Foto: ${photoPaths.length} file, Lokasi: ${locations.length}, Total formulir: ${totalPostings}`,
      "info",
    );
    this.emit(
      "log",
      "Lokasi dan Terbitkan akan dilakukan manual pada setiap formulir.",
      "warn",
    );

    if (totalPostings > 10) {
      this.emit(
        "log",
        `PERINGATAN: Total ${totalPostings} formulir dalam satu batch berisiko memicu spam filter Facebook. Disarankan maksimal 5-10 posting per sesi.`,
        "warn",
      );
    }

    try {
      let currentIndex = 0;

      for (let loop = 1; loop <= loops; loop++) {
        for (
          let locationIndex = 0;
          locationIndex < locations.length;
          locationIndex++
        ) {
          this.throwIfCancelled();
          const expectedLocation = locations[locationIndex];
          const postingNumber = currentIndex + 1;

          const photoIndex = currentIndex % photoPaths.length;
          const photoForThisPost = [photoPaths[photoIndex]];

          const dynamicTitle = parseSpintax(title);
          const dynamicDescription = addZeroWidthEntropy(parseSpintax(description));
          const dynamicSku = sku ? parseSpintax(sku) : "";
          const dynamicLabel = label ? parseSpintax(label) : "";

          const tag = `[Formulir ${postingNumber}/${totalPostings} | Lokasi: "${expectedLocation}"]`;
          this.emit(
            "log",
            `${tag} Menggunakan foto ke-${photoIndex + 1}`,
            "info",
          );
          if (dynamicTitle !== title) {
            this.emit(
              "log",
              `${tag} Variasi judul: "${dynamicTitle}"`,
              "info",
            );
          }
          this.emit("status", {
            state: "busy",
            text: `Posting ${postingNumber}/${totalPostings}...`,
          });

          await this.executeSinglePost(
            {
              photos: photoForThisPost,
              title: dynamicTitle,
              price,
              sku: dynamicSku,
              label: dynamicLabel,
              brand,
              category,
              subcategory,
              condition,
              description: dynamicDescription,
              expectedLocation,
            },
            tag,
          );

          this.throwIfCancelled();

          this.emit(
            "log",
            `${tag} Lokasi dan penerbitan telah dikonfirmasi manual.`,
            "success",
          );

          currentIndex++;

          // Cooldown optimal: 3-6 detik antar posting. Cukup agar network
          // socket selesai & bebas deteksi burst, tanpa membuang waktu.
          if (currentIndex < totalPostings) {
            const cooldownSeconds = randomInt(3, 6);
            this.emit(
              "log",
              `Menunggu ${cooldownSeconds} detik sebelum formulir berikutnya...`,
              "info",
            );
            await this.waitWithCancellation(cooldownSeconds * 1000);
          }
        }
      }

      this.emit(
        "log",
        `=== SEMUA ${totalPostings} FORMULIR SELESAI DIKONFIRMASI ===`,
        "success",
      );
      this.emit("status", {
        state: "active",
        text: "Sudah Login (Siap Posting)",
      });
      this.emit("complete");
      return { cancelled: false };
    } catch (err) {
      if (err.code === "BATCH_CANCELLED" || this.stopRequested) {
        this.emit("log", "Batch posting dibatalkan oleh pengguna.", "warn");
        const browserStillOpen =
          this.context && this.page && !this.page.isClosed() && this.isLoggedIn;
        this.emit(
          "status",
          browserStillOpen
            ? { state: "active", text: "Sudah Login (Siap Posting)" }
            : { state: "", text: "Browser Ditutup" },
        );
        this.emit("cancelled");
        return { cancelled: true };
      }
      this.emit("log", `Error saat posting: ${err.message}`, "error");
      this.emit("status", { state: "error", text: "Error Posting" });
      this.emit("error", err.message);
      throw err;
    } finally {
      this.running = false;
      this.stopRequested = false;
    }
  }

  async validatePayload(payload = {}) {
    const photoPaths = Array.isArray(payload.photos)
      ? payload.photos.filter(Boolean)
      : [];
    if (!photoPaths.length) throw new Error("Minimal sertakan 1 foto produk.");

    const missingPhoto = await Promise.all(
      photoPaths.map(async (photoPath) => {
        try {
          return !(await fs.stat(photoPath)).isFile();
        } catch {
          return true;
        }
      }),
    );
    if (missingPhoto.some(Boolean))
      throw new Error(
        "Satu atau lebih foto tidak ditemukan. Pilih ulang foto produk.",
      );

    const title = String(payload.title || "").trim();
    const price = String(payload.price || "").replace(/[^0-9]/g, "");
    const locations = (
      Array.isArray(payload.locations)
        ? payload.locations
        : String(payload.locations || "").split("/")
    )
      .map((location) => String(location || "").trim())
      .filter(Boolean);
    const category = String(payload.category || "").trim();
    const subcategory = String(payload.subcategory || "").trim();
    const condition = String(payload.condition || "").trim();
    const loops = Number.parseInt(payload.loops, 10);

    if (!title) throw new Error("Judul produk wajib diisi.");
    if (!price || Number(price) <= 0)
      throw new Error("Harga produk wajib berupa angka lebih dari 0.");
    if (!locations.length)
      throw new Error(
        "Masukkan minimal satu lokasi target. Pisahkan lokasi dengan tanda /.",
      );
    const categoryDefinition = MARKETPLACE_CATEGORIES[category];

    if (!categoryDefinition) {
      throw new Error(
        "Pilih kategori utama Marketplace dari daftar yang tersedia.",
      );
    }

    if (
      category !== "vehicles" &&
      !categoryDefinition.subcategories[subcategory]
    ) {
      throw new Error("Pilih subkategori Marketplace yang sesuai.");
    }
    if (condition && !MARKETPLACE_CONDITIONS[condition])
      throw new Error("Pilih kondisi barang dari daftar yang tersedia.");
    if (!Number.isInteger(loops) || loops < 1 || loops > 20)
      throw new Error("Jumlah perulangan harus antara 1 sampai 20 (demi keamanan akun).");

    return {
      photoPaths,
      locations,
      title,
      price,
      sku: String(payload.sku || "").trim(),
      label: String(payload.label || "").trim(),
      brand: String(payload.brand || "").trim(),
      category,
      subcategory,
      condition,
      description: String(payload.description || "").trim(),
      loops,
    };
  }

  cancelBatch() {
    if (!this.running) return false;
    this.stopRequested = true;
    this.manualAction?.resolve();
    this.emit(
      "log",
      "Permintaan pembatalan diterima. Menyelesaikan tahap aktif...",
      "warn",
    );
    return true;
  }

  continueAfterManualPublish() {
    if (!this.running || !this.manualAction) return false;
    this.manualAction.resolve();
    return true;
  }

  throwIfCancelled() {
    if (!this.stopRequested) return;
    const error = new Error("Batch dibatalkan.");
    error.code = "BATCH_CANCELLED";
    throw error;
  }

  async waitWithCancellation(milliseconds) {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
      this.throwIfCancelled();
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(250, deadline - Date.now())),
      );
    }
    this.throwIfCancelled();
  }

  async executeSinglePost(item, tag) {
    this.throwIfCancelled();
    this.emit("log", `${tag} Membuka tab formulir Marketplace baru...`, "info");
    const postPage = await this.context.newPage();
    this.page = postPage;
    this.page.setDefaultTimeout(45000);
    this.page.setDefaultNavigationTimeout(45000);
    this.emit(
      "log",
      `${tag} Membuka halaman Marketplace Create Item...`,
      "info",
    );
    await this.page.goto("https://www.facebook.com/marketplace/create/item", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await this.uploadPhotos(item.photos, tag);
    await this.humanDelay(200, 400);
    await this.fillTitle(item.title, tag);
    await this.humanDelay(150, 300);
    await this.fillPrice(item.price, tag);
    await this.humanDelay(150, 300);

    if (item.category !== "vehicles") {
      await this.openCategoryPicker(tag);
      await this.humanDelay(150, 300);
      await this.selectSubcategory(item.category, item.subcategory, tag);
    }

    await this.humanDelay(150, 300);
    await this.selectCondition(item.condition, tag);
    await this.humanDelay(100, 250);
    await this.fillSku(item.sku, tag);
    await this.humanDelay(100, 200);
    await this.fillLabel(item.label, tag);
    await this.humanDelay(100, 200);
    await this.fillBrand(item.brand, tag);
    await this.humanDelay(150, 350);
    await this.fillDescription(item.description, tag);
    await this.waitForUploadsToSettle(tag);
    await this.recheckCoreFields(item, tag);
    await this.typeLocation(item.expectedLocation, tag);
    await this.waitForManualLocationAndPublish(tag, item.expectedLocation);

    // Baris ini hanya tercapai kalau batch TIDAK dibatalkan (waitFor... memanggil
    // throwIfCancelled di akhir). Jadi tab dengan form yang belum terbit tidak
    // ikut tertutup saat pengguna menekan Batal.
    await this.closePostedTab(postPage, tag);
  }

  async closePostedTab(postPage, tag) {
    if (!this.closePostedTabs) return;
    if (!postPage || postPage.isClosed()) {
      this.restoreMainPage();
      return;
    }

    try {
      // Beri waktu singkat agar request penerbitan Facebook selesai
      // sebelum tab ditutup.
      await this.waitWithCancellation(1500);

      // Jangan sampai browser kehilangan tab terakhir (jendela ikut hilang).
      const survivors = this.context
        .pages()
        .filter((candidate) => candidate !== postPage && !candidate.isClosed());
      if (!survivors.length) {
        const holder = await this.context.newPage();
        holder.setDefaultTimeout(45000);
        holder.setDefaultNavigationTimeout(45000);
        this.mainPage = holder;
      }

      // runBeforeUnload default-nya false, jadi dialog "Tinggalkan halaman?"
      // dari Facebook tidak menghalangi penutupan.
      await postPage.close();
      this.emit("log", `${tag} Tab formulir ditutup otomatis.`, "info");
    } catch (err) {
      if (err.code === "BATCH_CANCELLED") throw err;
      this.emit(
        "log",
        `${tag} Gagal menutup tab otomatis: ${err.message}`,
        "warn",
      );
    } finally {
      this.restoreMainPage();
    }
  }

  restoreMainPage() {
    // this.page dipakai oleh deteksi login dan status browser. Setelah tab
    // posting ditutup, arahkan kembali ke tab yang masih hidup.
    if (this.page && !this.page.isClosed()) return;
    if (this.mainPage && !this.mainPage.isClosed()) {
      this.page = this.mainPage;
      return;
    }
    const alive = this.context
      ?.pages()
      .find((candidate) => !candidate.isClosed());
    if (alive) {
      this.mainPage = alive;
      this.page = alive;
    }
  }

  async uploadPhotos(photos, tag) {
    this.throwIfCancelled();
    this.emit("log", `${tag} Mengunggah foto...`, "info");
    const fileInput = this.page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: "attached", timeout: 20000 });
    await fileInput.setInputFiles(photos);

    // Tidak menunggu proses upload selesai: form langsung diisi sambil foto
    // diproses Facebook. Pengecekan upload dilakukan sebelum langkah manual
    // (lihat waitForUploadsToSettle).
    this.emit(
      "log",
      `${tag} Foto dikirim. Melanjutkan mengisi formulir...`,
      "success",
    );
  }

  // Hanya menunggu kalau ada progress bar yang BENAR-BENAR terlihat.
  // Selector lama `[aria-busy="true"]` cocok dengan elemen Facebook yang
  // selalu ada, sehingga dulu menunggu sampai 30 detik tanpa alasan.
  async waitForUploadsToSettle(tag, timeout = 8000) {
    const busy = this.page.locator('[role="progressbar"]:visible');
    const settled = await this.pollUntil(
      async () => ((await busy.count()) === 0 ? true : null),
      { timeout, interval: 100 },
    );
    if (!settled) {
      this.emit(
        "log",
        `${tag} Upload foto masih berjalan. Pastikan foto sudah muncul sebelum menerbitkan.`,
        "warn",
      );
    }
  }

  // Form React kadang me-render ulang setelah foto masuk dan menghapus isian
  // yang sudah diketik. Cek cepat, isi ulang hanya kalau memang berubah.
  async recheckCoreFields(item, tag) {
    const digits = (text) => String(text).replace(/[^0-9]/g, "");
    const plain = (text) =>
      String(text)
        .replace(/[\r\n\u200B-\u200D\uFEFF]/g, "")
        .trim();
    const checks = [
      {
        name: "judul",
        locator: this.titleLocator(),
        expected: item.title,
        clean: plain,
        refill: () => this.fillTitle(item.title, tag),
      },
      {
        name: "harga",
        locator: this.priceLocator(),
        expected: item.price,
        clean: digits,
        refill: () => this.fillPrice(item.price, tag),
      },
    ];

    for (const check of checks) {
      if (!check.expected) continue;
      let current;
      try {
        current = await check.locator.first().inputValue({ timeout: 1000 });
      } catch {
        continue;
      }
      if (check.clean(current) !== check.clean(check.expected)) {
        this.emit(
          "log",
          `${tag} Kolom ${check.name} berubah setelah upload foto. Mengisi ulang...`,
          "warn",
        );
        await check.refill();
      }
    }
  }

  // ---- Perilaku cepat & aman anti-deteksi ---------------------------------
  // Timing disesuaikan ke titik optimal: cepat untuk posting masif namun tetap
  // memicu event browser asli (mousemove, keypress, input, paste).

  async humanDelay(minMs = 150, maxMs = 350) {
    const ms = Math.round(minMs + Math.random() * (maxMs - minMs));
    await this.waitWithCancellation(ms);
  }

  // Gerakan mouse cepat ke elemen sebelum klik (cukup 2 step untuk trigger mousemove)
  async humanMouseMove(element) {
    try {
      const box = await element.boundingBox();
      if (!box) return;
      const targetX = box.x + box.width * (0.3 + Math.random() * 0.4);
      const targetY = box.y + box.height * (0.3 + Math.random() * 0.4);
      await this.page.mouse.move(targetX, targetY, { steps: 2 });
    } catch {
      // Element off-screen atau stale
    }
  }

  // Ketik cepat: untuk teks panjang (>60 karakter seperti deskripsi) gunakan
  // simulasi paste/insertText (perilaku wajar seller manusia yang copy-paste).
  // Untuk teks pendek (judul/harga), ketik cepat 10-25ms per karakter.
  async humanType(field, value) {
    await this.humanMouseMove(field);
    await field.click();
    await field.fill("");
    if (value.length > 60) {
      await new Promise((r) => setTimeout(r, 40 + Math.random() * 40));
      await this.page.keyboard.insertText(value);
      return;
    }
    for (const char of value) {
      this.throwIfCancelled();
      await field.type(char, { delay: 0 });
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 18));
    }
  }

  // Scroll cepat ke elemen
  async humanScrollTo(element) {
    try {
      await element.evaluate((el) => {
        el.scrollIntoView({ behavior: "auto", block: "center" });
      });
      await new Promise((r) => setTimeout(r, 30 + Math.random() * 40));
    } catch {
      await element.scrollIntoViewIfNeeded().catch(() => {});
    }
  }

  // ---- Helper pengisian cepat -------------------------------------------
  // Prinsip: begitu elemen terdeteksi, langsung dipakai. Tidak ada jeda tetap;
  // batas waktu (timeout) hanya berlaku kalau elemennya memang tidak muncul.

  // Ulangi `getter` sampai mengembalikan nilai truthy, lalu langsung kembali.
  async pollUntil(getter, { timeout = 10000, interval = 50 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      this.throwIfCancelled();
      const result = await getter().catch(() => null);
      if (result) return result;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  // Tunggu locator tampil (Playwright memantau tanpa jeda tetap).
  async waitForField(locator, timeout = 15000) {
    const field = locator.first();
    try {
      await field.waitFor({ state: "visible", timeout });
      return field;
    } catch {
      return null;
    }
  }

  // Isi field segera setelah muncul, lalu pastikan nilainya benar-benar masuk.
  async fillWhenReady(
    locator,
    value,
    { fieldName, tag = "", required = true, timeout, normalize } = {},
  ) {
    const field = await this.waitForField(
      locator,
      timeout ?? (required ? 20000 : 1500),
    );
    if (!field) {
      if (required)
        throw new Error(`Kolom ${fieldName} Marketplace tidak ditemukan.`);
      return false;
    }

    const clean =
      normalize ??
      ((text) =>
        String(text)
          .replace(/[\r\n\u200B-\u200D\uFEFF]/g, "")
          .trim());
    const expected = clean(value);

    for (let attempt = 1; attempt <= 3; attempt++) {
      this.throwIfCancelled();
      await this.humanScrollTo(field);
      // Ketik seperti manusia, bukan fill() instan yang bisa dideteksi
      await this.humanType(field, String(value));

      const ok = await this.pollUntil(
        async () => {
          try {
            return clean(await field.inputValue()) === expected;
          } catch {
            return true; // bukan input/textarea: tidak bisa diverifikasi
          }
        },
        { timeout: 800, interval: 40 },
      );
      if (ok) return true;
    }

    // Jangan hentikan batch hanya karena format tampilan berbeda; pengguna
    // tetap melihat formulir sebelum menerbitkan secara manual.
    this.emit(
      "log",
      `${tag} Nilai kolom ${fieldName} belum cocok setelah 3 percobaan. Periksa manual.`,
      "warn",
    );
    return true;
  }

  titleLocator() {
    return this.page.locator(
      'input[aria-label="Title"], input[aria-label="Judul"], label:has-text("Title") input, label:has-text("Judul") input',
    );
  }

  priceLocator() {
    return this.page.locator(
      'input[aria-label="Price"], input[aria-label="Harga"], label:has-text("Price") input, label:has-text("Harga") input',
    );
  }

  async fillTitle(title, tag) {
    if (!title) return;
    this.emit("log", `${tag} Mengisi judul: "${title}"`, "info");
    await this.fillWhenReady(this.titleLocator(), title, {
      fieldName: "judul",
      tag,
    });
  }

  async fillPrice(price, tag) {
    if (!price) return;
    this.emit("log", `${tag} Mengisi harga: Rp${price}`, "info");
    await this.fillWhenReady(this.priceLocator(), String(price), {
      fieldName: "harga",
      tag,
      // Facebook bisa menampilkan harga dengan pemisah ribuan.
      normalize: (text) => String(text).replace(/[^0-9]/g, ""),
    });
  }

  async selectCategory(categoryCode, tag) {
    const category = MARKETPLACE_CATEGORIES[categoryCode];
    if (!category)
      throw new Error("Kategori Marketplace yang dipilih tidak valid.");
    this.emit("log", `${tag} Memilih kategori: "${category.label}"`, "info");
    await this.selectMarketplaceChoice({
      controlSelector:
        '[aria-label="Category"], [aria-label="Kategori"], [role="combobox"][aria-label="Category"], [role="combobox"][aria-label="Kategori"]',
      aliases: category.aliases,
      fieldName: "kategori",
      fieldLabels: ["Category", "Kategori", "Pilih category", "Pilih kategori"],
    });
  }

  async selectSubcategory(categoryCode, subcategoryCode, tag) {
    const category = MARKETPLACE_CATEGORIES[categoryCode];

    if (!category) {
      throw new Error(`Kategori utama "${categoryCode}" tidak dikenal.`);
    }

    const subcategory = category.subcategories?.[subcategoryCode];

    if (!subcategory) {
      throw new Error(
        `Subkategori "${subcategoryCode}" tidak valid untuk "${category.label}".`,
      );
    }

    this.emit(
      "log",
      `${tag} Mencari pilihan "${subcategory.label}" di Marketplace...`,
      "info",
    );

    // Langsung ambil opsi begitu daftar muncul (tanpa jeda tetap).
    const option = await this.pollUntil(
      () => this.findExactMarketplaceOption(subcategory.aliases),
      { timeout: 8000, interval: 50 },
    );

    if (!option) {
      throw new Error(
        `${tag} Pilihan "${subcategory.label}" tidak ditemukan. Bot dihentikan agar tidak salah memilih kategori.`,
      );
    }

    await this.humanScrollTo(option);
    await this.humanMouseMove(option);

    // Jangan pernah klik kandidat pertama secara otomatis.
    await option.click();

    // Lanjut begitu daftar menutup; batas 1,5 dtk kalau daftar tetap terlihat.
    await option.waitFor({ state: "hidden", timeout: 1500 }).catch(() => {});

    this.emit(
      "log",
      `${tag} Pilihan kategori berhasil: "${subcategory.label}".`,
      "success",
    );
  }

  async openCategoryPicker(tag) {
    this.emit("log", `${tag} Membuka daftar kategori Marketplace...`, "info");

    const control = await this.findMarketplaceFieldControl(
      '[aria-label="Category"], [aria-label="Kategori"], [role="combobox"][aria-label="Category"], [role="combobox"][aria-label="Kategori"]',
      ["Category", "Kategori", "Pilih category", "Pilih kategori"],
    );

    if (!control) {
      throw new Error("Kolom kategori Marketplace tidak ditemukan.");
    }

    await this.humanScrollTo(control);
    await this.humanMouseMove(control);
    await control.click();
  }

  async findExactMarketplaceOption(aliases) {
    const normalizedAliases = aliases.map((value) =>
      value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase(),
    );

    const selectors = [
      '[role="option"]',
      '[role="menuitem"]',
      '[role="button"]',
      '[role="menuitemradio"]',
      '[role="radio"]',
    ].join(", ");

    const candidates = this.page.locator(selectors);
    const count = await candidates.count();

    for (let index = 0; index < count; index++) {
      const candidate = candidates.nth(index);

      if (!(await candidate.isVisible().catch(() => false))) {
        continue;
      }

      const rawText = await candidate.innerText().catch(() => "");

      const lines = rawText
        .split("\n")
        .map((line) =>
          line
            .normalize("NFKC")
            .replace(/\s+/g, " ")
            .trim()
            .toLocaleLowerCase(),
        )
        .filter(Boolean);

      if (!lines.length) {
        continue;
      }

      // Facebook sering menambahkan informasi seperti:
      // "Tersedia pengiriman"
      // pada baris kedua.
      //
      // Kita hanya mencocokkan nama kategori pada baris pertama.
      const mainLabel = lines[0];

      if (normalizedAliases.includes(mainLabel)) {
        return candidate;
      }
    }

    return null;
  }

  async selectCondition(conditionCode, tag) {
    if (!conditionCode) return;
    const condition = MARKETPLACE_CONDITIONS[conditionCode];
    if (!condition) throw new Error("Kondisi barang yang dipilih tidak valid.");
    this.emit("log", `${tag} Memilih kondisi: "${condition.label}"`, "info");
    await this.selectMarketplaceChoice({
      controlSelector:
        '[aria-label="Condition"], [aria-label="Kondisi"], [role="combobox"][aria-label="Condition"], [role="combobox"][aria-label="Kondisi"], input[placeholder="Condition"], input[placeholder="Kondisi"]',
      aliases: condition.aliases,
      fieldName: "kondisi barang",
      fieldLabels: ["Condition", "Kondisi", "Pilih condition", "Pilih kondisi"],
    });
  }

  async selectMarketplaceChoice({
    controlSelector,
    aliases,
    fieldName,
    fieldLabels,
  }) {
    const control = await this.findMarketplaceFieldControl(
      controlSelector,
      fieldLabels,
    );
    if (!control)
      throw new Error(`Kolom ${fieldName} Marketplace tidak ditemukan.`);

    await this.humanScrollTo(control);
    await this.humanMouseMove(control);
    await control.click();

    // Ambil opsi segera setelah terdeteksi.
    let option = await this.pollUntil(() => this.findOptionByAliases(aliases), {
      timeout: 1200,
    });
    if (!option) {
      const searchInput = await this.pollUntil(
        () =>
          this.findFirstVisible(
            this.page.locator(
              '[role="dialog"] input, [role="listbox"] input, input[aria-label="Search"], input[aria-label="Cari"]',
            ),
          ),
        { timeout: 500 },
      );
      if (searchInput) {
        await searchInput.fill(aliases[0]);
      } else {
        await this.page.keyboard.type(aliases[0]);
      }
      option = await this.pollUntil(() => this.findOptionByAliases(aliases), {
        timeout: 3000,
      });
    }

    if (!option)
      throw new Error(
        `Pilihan ${fieldName} tidak tersedia pada formulir Marketplace ini.`,
      );
    await option.click();
    await this.verifyMarketplaceChoice(control, aliases, fieldName);
  }

  async findMarketplaceFieldControl(
    controlSelector,
    fieldLabels,
    timeout = 15000,
  ) {
    const timeoutAt = Date.now() + timeout;
    const labelButtonSelector = fieldLabels
      .map(
        (label) =>
          `[role="button"]:has-text("${label}"), [role="combobox"]:has-text("${label}")`,
      )
      .join(", ");

    while (Date.now() < timeoutAt) {
      const directControl = await this.findFirstVisible(
        this.page.locator(controlSelector),
      );
      if (directControl) return directControl;

      const textControl = await this.findFirstVisible(
        this.page.locator(labelButtonSelector),
      );
      if (textControl) return textControl;

      for (const label of fieldLabels) {
        const labelledControl = await this.findFirstVisible(
          this.page.getByLabel(label, { exact: false }),
        );
        if (labelledControl) return labelledControl;

        const labelNode = await this.findFirstVisible(
          this.page.getByText(label, { exact: true }),
        );
        if (!labelNode) continue;

        const fieldContainer = labelNode.locator(
          "xpath=ancestor::*[.//*[@role='button' or @role='combobox' or self::input]][1]",
        );
        const nestedControl = await this.findFirstVisible(
          fieldContainer.locator('[role="button"], [role="combobox"], input'),
        );
        if (nestedControl) return nestedControl;

        const parentControl = await this.findFirstVisible(
          labelNode.locator(
            "xpath=ancestor-or-self::*[@role='button' or @role='combobox'][1]",
          ),
        );
        if (parentControl) return parentControl;

        const nearbyControl = await this.findFirstVisible(
          labelNode.locator(
            "xpath=following::*[@role='button' or @role='combobox'][1]",
          ),
        );
        if (nearbyControl) return nearbyControl;
      }

      await this.waitWithCancellation(100);
    }
    return null;
  }

  async verifyMarketplaceChoice(control, aliases, fieldName) {
    const readValue = async () =>
      (await control.innerText().catch(() => "")).trim().toLocaleLowerCase();
    const matches = (text) =>
      aliases.some((alias) => text.includes(alias.toLocaleLowerCase()));

    // Selesai begitu tampilan field berubah; tidak menunggu jeda tetap.
    const selected = await this.pollUntil(
      async () => (matches(await readValue()) ? true : null),
      { timeout: 3000, interval: 50 },
    );
    if (selected) return;

    if (!(await readValue())) return;
    throw new Error(
      `Nilai ${fieldName} tidak berubah setelah dipilih. Coba buka ulang formulir Marketplace.`,
    );
  }

  async findOptionByAliases(aliases) {
    for (const alias of aliases) {
      const roleOption = await this.findFirstVisible(
        this.page.getByRole("option", { name: alias, exact: false }),
      );
      if (roleOption) return roleOption;

      const menuChoice = await this.findFirstVisible(
        this.page
          .locator('[role="menuitem"], [role="button"]')
          .filter({ hasText: alias }),
      );
      if (menuChoice) return menuChoice;
    }
    return null;
  }

  async findFirstVisible(locator) {
    const count = await locator.count();
    for (let index = 0; index < count; index++) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    return null;
  }

  async fillSku(sku, tag) {
    if (!sku) return;
    this.emit("log", `${tag} Mengisi SKU: "${sku}"`, "info");
    await this.fillWhenReady(
      this.page.locator(
        'input[aria-label="SKU"], input[aria-label="Sku"], label:has-text("SKU") input, input[aria-label="Kode"]',
      ),
      sku,
      { fieldName: "SKU", tag, required: false, timeout: 1500 },
    );
  }

  async fillLabel(label, tag) {
    await this.fillMarketplaceTextField(label, tag, {
      fieldName: "label",
      selectors:
        'input[aria-label*="Label" i], input[aria-label*="Tag" i], input[placeholder*="Label" i], input[placeholder*="Tag" i], input[name*="label" i], input[name*="tag" i], [role="combobox"][aria-label*="Label" i], [role="combobox"][aria-label*="Tag" i], label:has-text("Label") input, label:has-text("Tag") input, [contenteditable="true"][aria-label*="Label" i]',
      fieldLabels: ["Label", "Label produk", "Tag", "Tag produk"],
    });
  }

  async fillBrand(brand, tag) {
    await this.fillMarketplaceTextField(brand, tag, {
      fieldName: "merek",
      selectors:
        'input[aria-label*="Brand" i], input[aria-label*="Merek" i], input[placeholder*="Brand" i], input[placeholder*="Merek" i], input[name*="brand" i], input[name*="merek" i], [role="combobox"][aria-label*="Brand" i], [role="combobox"][aria-label*="Merek" i], label:has-text("Brand") input, label:has-text("Merek") input, [contenteditable="true"][aria-label*="Brand" i], [contenteditable="true"][aria-label*="Merek" i]',
      fieldLabels: ["Brand", "Merek", "Pilih Brand", "Pilih Merek"],
    });
  }

  async fillMarketplaceTextField(
    value,
    tag,
    { fieldName, selectors, fieldLabels },
  ) {
    if (!value) return;
    this.emit("log", `${tag} Mengisi ${fieldName}: "${value}"`, "info");

    let input = await this.findFirstVisible(this.page.locator(selectors));
    let openedControl = null;
    if (!input) {
      const control = await this.findMarketplaceFieldControl(
        selectors,
        fieldLabels,
        4000,
      );
      if (!control) {
        this.emit(
          "log",
          `${tag} Kolom ${fieldName} tidak tersedia pada kategori ini. Lewati isian dan lanjutkan ke formulir.`,
          "warn",
        );
        return;
      }
      openedControl = control;
      await this.humanScrollTo(control);
      await this.humanMouseMove(control);
      await control.click();
      const controlTagName = await control
        .evaluate((element) => element.tagName.toLowerCase())
        .catch(() => "");
      const controlIsEditable =
        (await control.getAttribute("contenteditable").catch(() => null)) ===
        "true";
      input =
        ["input", "textarea"].includes(controlTagName) || controlIsEditable
          ? control
          : await this.findFirstVisible(
              control.locator('input, textarea, [contenteditable="true"]'),
            );
      if (!input) {
        input = await this.findFirstVisible(
          this.page.locator(
            '[role="dialog"] input, [role="listbox"] input, [role="dialog"] [contenteditable="true"]',
          ),
        );
      }
    }

    try {
      if (input) {
        await this.setMarketplaceText(input, value);
      } else if (openedControl) {
        // Beberapa versi Marketplace membuka daftar pilihan tanpa input pencarian.
        // Ketik langsung ke daftar tersebut agar penyaring bawaan Facebook tetap bekerja.
        await this.page.keyboard.type(value);
      } else {
        this.emit(
          "log",
          `${tag} Kolom ${fieldName} tidak dapat dibuka pada formulir ini. Lewati isian dan lanjutkan ke formulir.`,
          "warn",
        );
        return;
      }

      const option = await this.findOptionByAliases([value]);
      if (option) {
        await option.click();
      }
    } catch (error) {
      this.emit(
        "log",
        `${tag} Gagal mengisi ${fieldName}: ${error.message}. Lewati isian dan lanjutkan ke formulir.`,
        "warn",
      );
    }
  }

  async setMarketplaceText(field, value) {
    await this.humanScrollTo(field);
    const isEditable =
      (await field.getAttribute("contenteditable").catch(() => null)) ===
      "true";
    if (isEditable) {
      await this.humanMouseMove(field);
      await field.click();
      await this.page.keyboard.press("Control+A");
      if (value.length > 60) {
        await new Promise((r) => setTimeout(r, 40 + Math.random() * 40));
        await this.page.keyboard.insertText(value);
        return;
      }
      for (const char of value) {
        await this.page.keyboard.type(char, { delay: 0 });
        await new Promise((r) => setTimeout(r, 10 + Math.random() * 18));
      }
      return;
    }
    await this.humanMouseMove(field);
    await field.click();
    await field.fill("");
    if (value.length > 60) {
      await new Promise((r) => setTimeout(r, 40 + Math.random() * 40));
      await this.page.keyboard.insertText(value);
      return;
    }
    for (const char of value) {
      await field.type(char, { delay: 0 });
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 18));
    }
  }

  async fillDescription(description, tag) {
    if (!description) return;
    this.emit("log", `${tag} Mengisi deskripsi...`, "info");
    // Selector spesifik atau textarea apa pun (fallback lama), mana yang
    // muncul lebih dulu langsung dipakai.
    await this.fillWhenReady(
      this.page.locator(
        'textarea[aria-label="Description"], textarea[aria-label="Deskripsi"], label:has-text("Description") textarea, label:has-text("Deskripsi") textarea, textarea',
      ),
      description,
      { fieldName: "deskripsi", tag, required: false, timeout: 3000 },
    );
  }

  async typeLocation(location, tag) {
    if (!location) return;
    this.emit(
      "log",
      `${tag} Mengetik lokasi: "${location}" (tanpa memilih saran)...`,
      "info",
    );
    const selectors = [
      'input[aria-label="Location"]',
      'input[aria-label="Lokasi"]',
      'input[placeholder="Location"]',
      'input[placeholder="Lokasi"]',
      'input[name*="location" i]',
      'input[name*="lokasi" i]',
      'label:has-text("Location") input',
      'label:has-text("Lokasi") input',
    ].join(", ");
    let field = await this.findFirstVisible(this.page.locator(selectors));
    if (!field) {
      const control = await this.findMarketplaceFieldControl(selectors, [
        "Location",
        "Lokasi",
      ]);
      if (control) {
        const tagName = await control
          .evaluate((element) => element.tagName.toLowerCase())
          .catch(() => "");
        field =
          tagName === "input"
            ? control
            : await this.findFirstVisible(control.locator("input"));
      }
    }

    if (!field) throw new Error("Kolom lokasi Marketplace tidak ditemukan.");
    await this.setMarketplaceText(field, location);
  }

  async waitForManualLocationAndPublish(tag, expectedLocation) {
    this.throwIfCancelled();
    this.emit(
      "log",
      `${tag} Formulir siap. Pilih saran lokasi yang sudah diketik, lalu tekan Terbitkan secara manual.`,
      "warn",
    );
    this.emit("status", {
      state: "busy",
      text: `${tag} Menunggu lokasi & Terbitkan manual`,
    });

    let lastDetectedLocation = "";
    const detectLocation = async () => {
      const selectedLocation = await this.detectSelectedMarketplaceLocation();
      if (!selectedLocation || selectedLocation === lastDetectedLocation)
        return;

      lastDetectedLocation = selectedLocation;
      const normalizedExpected = expectedLocation.toLocaleLowerCase();
      const normalizedSelected = selectedLocation.toLocaleLowerCase();
      const matchesExpected =
        normalizedSelected.includes(normalizedExpected) ||
        normalizedExpected.includes(normalizedSelected);
      this.emit(
        "log",
        `${tag} Lokasi manual terdeteksi: "${selectedLocation}"${matchesExpected ? "" : ` (target: "${expectedLocation}")`}.`,
        matchesExpected ? "success" : "warn",
      );
      this.emit("manual_location_selected", {
        tag,
        selectedLocation,
        expectedLocation,
        matchesExpected,
      });
    };

    let action;
    const isPublished = async () => {
      const currentUrl = this.page.url();
      if (!/\/marketplace\/create\/item/i.test(currentUrl)) return true;

      const bodyText = await this.page
        .locator("body")
        .innerText()
        .catch(() => "");
      return /(your listing (is|was) (now )?published|listing published|your item (is|was) (now )?published|iklan anda (sudah |telah )?diterbitkan|barang anda (sudah |telah )?diterbitkan|listing berhasil diterbitkan|berhasil menerbitkan)/i.test(
        bodyText,
      );
    };

    const monitorManualActions = async () => {
      await detectLocation();
      if (await isPublished()) {
        this.emit(
          "log",
          `${tag} Penerbitan manual terdeteksi. Membuka formulir berikutnya...`,
          "success",
        );
        this.manualAction?.resolve();
      }
    };

    await monitorManualActions();
    const manualWatcher = setInterval(() => {
      monitorManualActions().catch(() => {});
    }, 300);

    try {
      await new Promise((resolve) => {
        action = { resolve };
        this.manualAction = action;
        this.emit("manual_action_required", {
          waiting: true,
          tag,
          requiresConfirmation: false,
        });
      });
    } finally {
      clearInterval(manualWatcher);
      if (this.manualAction === action) this.manualAction = null;
      this.emit("manual_action_required", { waiting: false });
    }

    this.throwIfCancelled();
  }

  async detectSelectedMarketplaceLocation() {
    const visibleSuggestion = await this.findFirstVisible(
      this.page.locator(
        '[role="listbox"] [role="option"], [role="listbox"] li',
      ),
    );
    if (visibleSuggestion) return "";

    const locationControls = this.page.locator(
      [
        'input[aria-label="Location"]',
        'input[aria-label="Lokasi"]',
        'input[placeholder="Location"]',
        'input[placeholder="Lokasi"]',
        '[role="combobox"][aria-label="Location"]',
        '[role="combobox"][aria-label="Lokasi"]',
      ].join(", "),
    );

    const count = await locationControls.count();
    for (let index = 0; index < count; index++) {
      const control = locationControls.nth(index);
      if (!(await control.isVisible().catch(() => false))) continue;
      if (
        (await control.getAttribute("aria-expanded").catch(() => null)) ===
        "true"
      )
        continue;

      const value = (
        (await control.inputValue().catch(() => "")) ||
        (await control.innerText().catch(() => ""))
      ).trim();
      if (value && !/^(location|lokasi)$/i.test(value)) return value;
    }
    return "";
  }

  async close() {
    if (this.detectionTimer) {
      clearInterval(this.detectionTimer);
      this.detectionTimer = null;
    }
    this.cancelBatch();
    this.isLoggedIn = false;

    try {
      if (this.page && !this.page.isClosed()) await this.page.close();
    } catch {}
    try {
      if (this.context) await this.context.close();
    } catch {}
    try {
      if (this.browser && this.browser.isConnected())
        await this.browser.close();
    } catch {}

    this.browser = null;
    this.context = null;
    this.page = null;
    this.mainPage = null;

    this.emit("log", "Browser telah ditutup.", "info");
    this.emit("status", { state: "", text: "Browser Ditutup" });
    this.emit("login_status", { isLoggedIn: false });
  }
}
