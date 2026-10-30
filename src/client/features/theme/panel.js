// src/client/features/theme/panel.js
// 「设置 → 用量聚合 → 主题外观」面板（迁移前是独立的「设置 → AxzoTheme」入口）。
//
// 面板只负责「换值」，不负责回收 token 覆盖层 —— 覆盖层的所有权在 tokens.js。

import { brandPreviewSrc, fileToLogo } from './assets.js';
import { BrandMark, BrandName } from './brand-mark.js';
import { DEFAULT_BRAND, FONTS, OFFICIAL_NAME, resolveFont } from './brand.js';
import { hslToHex } from './color.js';
import { DEFAULT_PRIMARY, LOGO_MAX_CHARS, PANEL_STYLE_ID, PLUGIN_ID, PRESETS } from './constants.js';
import { HeroBrandMark } from './hero.js';
import { osTintMax } from './os-prefs.js';
import { getPrefs, prefs, setPrefs, usePrefs } from './prefs.js';
import { h, useCallback, useEffect, useState } from '../../runtime.js';


/* ───────────────────────── 设置面板 ────────────────────────────── */
function sliderTrack(field, primary) {
  var hue = primary.h, sat = primary.s, lig = primary.l;
  if (field === "h") {
    return "linear-gradient(90deg,#f43f5e,#f59e0b,#84cc16,#10b981,#06b6d4,#6366f1,#a855f7,#f43f5e)";
  }
  if (field === "s") {
    return "linear-gradient(90deg," + hslToHex(hue, 0, lig) + "," + hslToHex(hue, 100, lig) + ")";
  }
  return "linear-gradient(90deg,#0b0f14," + hslToHex(hue, sat, 50) + ",#ffffff)";
}


function Slider(props) {
  return h("label", { className: "axzt-row" },
    h("span", { className: "axzt-row-label" }, props.label),
    h("input", {
      type: "range", className: "axzt-range", style: { background: props.track },
      min: props.min, max: props.max, step: props.step || 1, value: props.value,
      "aria-label": props.label,
      onChange: function (e) { props.onInput(props.field, Number(e.target.value)); }
    }),
    h("span", { className: "axzt-row-value" }, props.value + (props.unit || ""))
  );
}


function Switch(props) {
  return h("div", { className: "axzt-switch-row" },
    h("div", { className: "axzt-switch-text" },
      h("div", { className: "axzt-switch-title" }, props.title),
      h("div", { className: "axzt-switch-hint" }, props.hint)
    ),
    h("button", {
      type: "button",
      className: "axzt-switch" + (props.on ? " is-on" : ""),
      "aria-pressed": props.on, "aria-label": props.title, onClick: props.onToggle
    }, h("span", { className: "axzt-switch-thumb" }))
  );
}


function PresetRow(props) {
  return h("div", { className: "axzt-presets" },
    PRESETS.map(function (preset) {
      var isOn = props.active.h === preset.h && props.active.s === preset.s && props.active.l === preset.l;
      return h("button", {
        key: preset.id, type: "button",
        className: "axzt-preset" + (isOn ? " is-on" : ""),
        title: preset.label, "aria-label": preset.label, "aria-pressed": isOn,
        onClick: function () { props.onPick(preset); }
      },
        h("span", { className: "axzt-preset-dot", style: { background: hslToHex(preset.h, preset.s, preset.l) } }),
        h("span", { className: "axzt-preset-label" }, preset.label)
      );
    })
  );
}


/**
 * 实时预览。
 *
 * 一律用**真实组件**（BrandMark / BrandName / HeroBrandMark），不手搓第二套小样 ——
 * 手搓的那套只反映它自己建模过的那几个字段，自定义 logo、品牌名、深浅模式全都
 * 反映不出来，表现出来就是「改了配置预览没反应」。配色也全部走真实 CSS 变量，
 * 深浅两套自动跟上，不需要在这里重算一遍 token。
 */
function Preview(props) {
  var t = props.t;
  var prefs = usePrefs();
  var hex = hslToHex(prefs.primary.h, prefs.primary.s, prefs.primary.l);
  var sample = "Aa " + (prefs.brand.name === "" ? DEFAULT_BRAND.name : prefs.brand.name);

  return h("div", { className: "axzt-preview" },
    h("div", { className: "axzt-preview-head" },
      h("span", null, t("preview")),
      h("code", { className: "axzt-hex" }, hex)
    ),

    h("div", { className: "axzt-stage" },
      h("span", { className: "axzt-stage-tag" }, t("previewBrand")),
      h("span", { className: "axzt-brand-strip" },
        h(BrandMark, { size: 24 }),
        h(BrandName)
      )
    ),

    h("div", { className: "axzt-stage axzt-stage-hero" },
      h("span", { className: "axzt-stage-tag" }, t("previewHero")),
      h("div", { className: "axzt-hero-demo" }, h(HeroBrandMark))
    ),

    h("div", { className: "axzt-stage axzt-stage-surface" },
      h("span", { className: "axzt-stage-tag" }, t("previewSurface")),
      h("div", { className: "axzt-surface-demo" },
        h("div", { className: "axzt-surface-card" },
          h("div", { className: "axzt-surface-line" }),
          h("div", { className: "axzt-surface-row" },
            h("span", { className: "axzt-surface-dot" }),
            h("span", { className: "axzt-surface-text" }, sample)
          )
        )
      )
    ),

    h("div", { className: "axzt-bubble is-user" }, t("previewUser")),
    h("div", { className: "axzt-bubble is-bot" },
      t("previewReply").replace("{hex}", hex))
  );
}


const PANEL_CSS = [
  ".axzt-panel{display:flex;flex-direction:column;gap:16px;padding:20px 24px 48px;max-width:780px}",
  ".axzt-card{display:flex;flex-direction:column;gap:12px;padding:16px 18px;border:.5px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-module-platform)}",
  ".axzt-card-title{margin:0;font-size:13px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-primary)}",
  ".axzt-card-sub{margin:-6px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}",
  ".axzt-note{margin:2px 0 0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}",
  ".axzt-row{display:grid;grid-template-columns:52px 1fr 56px;align-items:center;gap:12px}",
  ".axzt-row-label{font-size:13px;color:var(--dsw-alias-label-secondary)}",
  ".axzt-row-value{font-variant-numeric:tabular-nums;font-size:12px;text-align:right;color:var(--dsw-alias-label-tertiary)}",
  ".axzt-range{-webkit-appearance:none;appearance:none;width:100%;height:5px;border-radius:5px;outline:none;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l2)}",
  ".axzt-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:15px;height:15px;border-radius:50%;background:#fff;border:2px solid var(--dsh-axzo-brand,#0aa96c);box-shadow:0 1px 4px rgba(0,0,0,.22);cursor:pointer;transition:transform .15s}",
  ".axzt-range::-webkit-slider-thumb:hover{transform:scale(1.12)}",
  ".axzt-range::-moz-range-thumb{width:15px;height:15px;border-radius:50%;background:#fff;border:2px solid var(--dsh-axzo-brand,#0aa96c);cursor:pointer}",
  ".axzt-btn{align-self:flex-start;padding:5px 12px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}",
  ".axzt-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
  ".axzt-presets{display:flex;flex-wrap:wrap;gap:8px}",
  ".axzt-preset{display:flex;align-items:center;gap:7px;padding:6px 11px 6px 7px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;cursor:pointer;transition:border-color .16s,background .16s}",
  ".axzt-preset:hover{background:var(--dsw-alias-interactive-bg-hover)}",
  ".axzt-preset.is-on{border-color:var(--dsh-axzo-brand,#0aa96c);background:var(--dsh-axzo-brand-soft,rgba(10,169,108,.12))}",
  ".axzt-preset-dot{width:14px;height:14px;border-radius:50%;box-shadow:inset 0 0 0 .5px rgba(0,0,0,.12)}",
  ".axzt-preset-label{font-size:12px;color:var(--dsw-alias-label-secondary)}",
  ".axzt-switch-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:6px 0}",
  ".axzt-switch-text{flex:1;min-width:0}",
  ".axzt-switch-title{font-size:13px;color:var(--dsw-alias-label-primary)}",
  ".axzt-switch-hint{margin-top:2px;font-size:12px;line-height:1.45;color:var(--dsw-alias-label-tertiary)}",
  ".axzt-switch{flex:0 0 auto;position:relative;width:36px;height:20px;padding:0;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:background .18s,border-color .18s}",
  ".axzt-switch.is-on{background:var(--dsh-axzo-brand,#0aa96c);border-color:var(--dsh-axzo-brand,#0aa96c)}",
  ".axzt-switch-thumb{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .18s}",
  ".axzt-switch.is-on .axzt-switch-thumb{transform:translateX(16px)}",
  ".axzt-preview{display:flex;flex-direction:column;gap:12px}",
  ".axzt-preview-head{display:flex;align-items:center;justify-content:space-between;font-size:13px;color:var(--dsw-alias-label-secondary)}",
  ".axzt-hex{padding:2px 8px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--dsw-alias-label-primary)}",
  ".axzt-stage{display:flex;flex-direction:column;align-items:flex-start;gap:10px;padding:16px 18px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}",
  ".axzt-stage-tag{font-size:11px;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary)}",
  ".axzt-brand-strip{display:inline-flex;align-items:center;gap:8px}",
  ".axzt-pv-word{display:block;color:var(--dsw-alias-label-primary)}",
  ".axzt-hero-demo{display:flex;flex-direction:column;align-items:center;align-self:center;padding:6px 0 2px}",
  ".axzt-surface-demo{width:100%;border-radius:10px;padding:12px;background:var(--dsw-alias-bg-base)}",
  ".axzt-surface-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;background:var(--dsw-alias-bg-module-platform)}",
  ".axzt-surface-line{height:1px;border-radius:1px;background:var(--dsw-alias-border-l2)}",
  ".axzt-surface-row{display:flex;align-items:center;gap:8px;margin-top:9px}",
  ".axzt-surface-dot{width:16px;height:16px;border-radius:5px;border:.5px solid var(--dsh-axzo-brand);background:var(--dsw-alias-button-ghost-active-fill)}",
  ".axzt-surface-text{font-size:13px;color:var(--dsw-alias-label-primary)}",
  ".axzt-bubble{padding:8px 12px;border-radius:10px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}",
  ".axzt-bubble.is-user{align-self:flex-end;max-width:82%;background:var(--dsh-axzo-brand-soft)}",
  ".axzt-bubble.is-bot{padding-left:14px;background:var(--dsw-alias-bg-module-platform);border-left:2px solid var(--dsh-axzo-brand)}",
  ".axzt-swatches{display:flex;gap:8px}",
  ".axzt-swatch{width:46px;height:22px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l2)}",
  ".axzt-logo-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
  ".axzt-logo-preview{width:38px;height:38px;border-radius:10px;display:grid;place-items:center;flex:none;overflow:hidden;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3)}",
  ".axzt-logo-preview img{width:24px;height:24px;object-fit:contain}",
  ".axzt-logo-tag{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-right:2px}",
  ".axzt-file{display:none}",
  ".axzt-file-btn{display:inline-flex;align-items:center;cursor:pointer}",
  ".axzt-input{width:100%;margin-top:6px;padding:7px 10px;border-radius:8px;font-size:13px;font-family:inherit;outline:none;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}",
  ".axzt-input::placeholder{color:var(--dsw-alias-label-tertiary)}",
  ".axzt-input:focus{border-color:var(--dsh-axzo-brand,#0aa96c)}",
  ".axzt-field{display:block;margin-top:10px}",
  ".axzt-fonts{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px}",
  ".axzt-font{padding:5px 11px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;cursor:pointer;font-size:14px;line-height:1.5;color:var(--dsw-alias-label-primary);transition:border-color .15s,background .15s}",
  ".axzt-font:hover{background:var(--dsw-alias-interactive-bg-hover)}",
  ".axzt-font.is-on{border-color:var(--dsh-axzo-brand,#0aa96c);background:var(--dsh-axzo-brand-soft,rgba(10,169,108,.12))}",
  ".axzt-field-label{display:block;font-size:12px;color:var(--dsw-alias-label-secondary)}",
  ".axzt-note{margin:8px 0 0;font-size:12px;color:var(--dsh-axzo-brand,#0aa96c)}"
].join("\n");


export function Panel(props) {
  var t = props.t;

  // 直接订阅运行时单例：面板永远只是当前真源的一个视图。
  // 这样既不会「重开设置看到旧颜色」，也不会和别处的改动脱节。
  var prefs = usePrefs();
  var primary = prefs.primary;
  var flags = prefs.flags;
  var brand = prefs.brand;

  var noteState = useState("");
  var note = noteState[0];
  var setNote = noteState[1];
  var comfortState = useState("");
  var comfortNote = comfortState[0];
  var setComfortNote = comfortState[1];
  var urlState = useState("");
  var urlDraft = urlState[0];
  var setUrlDraft = urlState[1];

  useEffect(function () {
    if (typeof document === "undefined") return undefined;
    if (document.getElementById(PANEL_STYLE_ID) !== null) return undefined;
    var tag = document.createElement("style");
    tag.id = PANEL_STYLE_ID;
    tag.setAttribute("data-plugin", PLUGIN_ID);
    tag.textContent = PANEL_CSS;
    document.head.appendChild(tag);
    return undefined;
  }, []);

  // 所有写入都从 getPrefs() 取实时值再合并 —— 面板闭包里的 prefs 可能落后
  // 于用户刚敲进去的那一个字符。
  var patchBrand = useCallback(function (patch) {
    var base = getPrefs().brand;
    var next = { logo: base.logo, font: base.font, name: base.name, tagline: base.tagline, subtag: base.subtag };
    for (var k in patch) next[k] = patch[k];
    setPrefs({ brand: next });
  }, []);

  var patchFlags = useCallback(function (patch) {
    var base = getPrefs().flags;
    var next = {};
    for (var k in base) next[k] = base[k];
    for (var k2 in patch) next[k2] = patch[k2];
    setPrefs({ flags: next });
  }, []);

  var setPrimary = useCallback(function (next) { setPrefs({ primary: next }); }, []);

  var onInput = useCallback(function (field, value) {
    var cur = getPrefs().primary;
    var next = { h: cur.h, s: cur.s, l: cur.l };
    next[field] = value;
    setPrefs({ primary: next });
  }, []);

  var onPick = useCallback(function (preset) {
    setPrefs({ primary: { h: preset.h, s: preset.s, l: preset.l } });
  }, []);

  var reset = useCallback(function () {
    setPrefs({ primary: { h: DEFAULT_PRIMARY.h, s: DEFAULT_PRIMARY.s, l: DEFAULT_PRIMARY.l } });
  }, []);

  var toggle = useCallback(function (key) {
    var patch = {};
    patch[key] = !getPrefs().flags[key];
    patchFlags(patch);
  }, [patchFlags]);

  var onFile = useCallback(function (event) {
    var input = event.target;
    var file = input.files && input.files[0];
    input.value = "";   // 清空，否则连续选同一个文件不会再触发 change
    if (!file) return;
    fileToLogo(file, function (dataUrl) {
      patchBrand({ logo: dataUrl });
      setNote(t("logoReady"));
    }, function (key) { setNote(t(key)); });
  }, [patchBrand, t]);

  // 在线地址不逐字符生效：半截 URL 会被校验挡掉，然后 logo 一闪一闪的。
  // 改成失焦或回车时再提交。
  var applyUrl = useCallback(function () {
    var raw = urlDraft.trim();
    if (raw === "") { setNote(""); return; }
    if (!/^https?:\/\//i.test(raw)) { setNote(t("logoUrlBad")); return; }
    if (raw.length > LOGO_MAX_CHARS) { setNote(t("tooBig")); return; }
    patchBrand({ logo: raw });
    setNote(t("logoReady"));
  }, [urlDraft, patchBrand, t]);

  var lowStrain = useCallback(function () {
    patchFlags({ washLevel: 25, glass: false, motion: false });
    setComfortNote(t("comfortApplied"));
  }, [patchFlags, t]);

  return h("div", { className: "axzt-panel" },
    h("section", { className: "axzt-card" },
      h("h3", { className: "axzt-card-title" }, t("sectionPreset")),
      h("p", { className: "axzt-card-sub" }, t("hintPersist")),
      h(PresetRow, { active: primary, onPick: onPick })
    ),
    h("section", { className: "axzt-card" },
      h("h3", { className: "axzt-card-title" }, t("sectionColor")),
      h(Slider, { label: t("hue"), field: "h", min: 0, max: 360, value: primary.h, unit: "°", onInput: onInput, track: sliderTrack("h", primary) }),
      h(Slider, { label: t("saturation"), field: "s", min: 0, max: 100, value: primary.s, unit: "%", onInput: onInput, track: sliderTrack("s", primary) }),
      h(Slider, { label: t("lightness"), field: "l", min: 12, max: 82, value: primary.l, unit: "%", onInput: onInput, track: sliderTrack("l", primary) }),
      h("button", { type: "button", className: "axzt-btn", onClick: reset }, t("reset"))
    ),
    h("section", { className: "axzt-card" },
      h("h3", { className: "axzt-card-title" }, t("sectionBrand")),
      h("p", { className: "axzt-card-sub" }, t("brandHint")),
      h("div", { className: "axzt-logo-row" },
        h("span", { className: "axzt-logo-preview" },
          h("img", { src: brandPreviewSrc(brand, primary), alt: "" })
        ),
        h("span", { className: "axzt-logo-tag" }, brand.logo === "" ? t("logoBuiltin") : t("logoCustom")),
        h("label", { className: "axzt-btn axzt-file-btn" },
          t("pickFile"),
          h("input", { type: "file", accept: "image/*", className: "axzt-file", onChange: onFile })
        ),
        h("button", {
          type: "button", className: "axzt-btn",
          onClick: function () { patchBrand({ logo: "" }); setNote(""); }
        }, t("resetLogo"))
      ),
      h("input", {
        type: "text", className: "axzt-input", value: urlDraft,
        placeholder: t("logoUrlPlaceholder"),
        onChange: function (e) { setUrlDraft(e.target.value); },
        onBlur: applyUrl,
        onKeyDown: function (e) { if (e.key === "Enter") { e.preventDefault(); applyUrl(); } }
      }),
      note === "" ? null : h("p", { className: "axzt-note" }, note),
      h("label", { className: "axzt-field" },
        h("span", { className: "axzt-field-label" }, t("nameLabel")),
        h("input", {
          type: "text", className: "axzt-input", value: brand.name, maxLength: 24,
          placeholder: DEFAULT_BRAND.name,
          onChange: function (e) { patchBrand({ name: e.target.value }); }
        })
      ),
      // 品牌名还是默认值时字标走的是内置矢量轮廓，字体对它无效 —— 这时候不显示字体选择
      brand.name === "" || brand.name === OFFICIAL_NAME ? null : h("div", { className: "axzt-field" },
        h("span", { className: "axzt-field-label" }, t("fontLabel")),
        // 每个按钮用它自己的字体渲染自己 —— 不用点开试就知道长什么样
        h("div", { className: "axzt-fonts" },
          FONTS.map(function (f) {
            var on = resolveFont(brand).id === f.id;
            return h("button", {
              key: f.id === "" ? "official" : f.id,
              type: "button",
              className: "axzt-font" + (on ? " is-on" : ""),
              "aria-pressed": on,
              title: f.stack,
              style: { fontFamily: f.stack, fontWeight: f.weight },
              onClick: function () { patchBrand({ font: f.id }); }
            }, f.label);
          })
        )
      ),
      h("label", { className: "axzt-field" },
        h("span", { className: "axzt-field-label" }, t("taglineLabel")),
        h("input", {
          type: "text", className: "axzt-input", value: brand.tagline, maxLength: 40,
          placeholder: DEFAULT_BRAND.tagline,
          onChange: function (e) { patchBrand({ tagline: e.target.value }); }
        })
      ),
      h("label", { className: "axzt-field" },
        h("span", { className: "axzt-field-label" }, t("subtagLabel")),
        h("input", {
          type: "text", className: "axzt-input", value: brand.subtag, maxLength: 56,
          placeholder: DEFAULT_BRAND.subtag,
          onChange: function (e) { patchBrand({ subtag: e.target.value }); }
        })
      ),
      h("button", {
        type: "button", className: "axzt-btn",
        onClick: function () {
          setPrefs({ brand: {
            logo: "", font: "", name: DEFAULT_BRAND.name,
            tagline: DEFAULT_BRAND.tagline, subtag: DEFAULT_BRAND.subtag
          } });
          setUrlDraft("");
          setNote("");
        }
      }, t("resetBrand"))
    ),
    h("section", { className: "axzt-card" },
      h("h3", { className: "axzt-card-title" }, t("surfaceTitle")),
      h("p", { className: "axzt-card-sub" }, t("surfaceHint")),
      h(Slider, {
        label: t("tintLabel"), field: "tint", min: 0, max: osTintMax(), value: flags.tint, unit: "%",
        // 用 CSS 变量而不是定值：深浅两套下都要跟着主题走
        track: "linear-gradient(90deg,var(--dsw-alias-bg-layer-3,#fff)," +
          "var(--dsh-axzo-brand-soft,rgba(10,169,108,.2)),var(--dsh-axzo-brand,#0aa96c))",
        onInput: function (_f, v) { patchFlags({ tint: v }); }
      })
    ),
    h("section", { className: "axzt-card" },
      h("h3", { className: "axzt-card-title" }, t("sectionFx")),
      h(Switch, { title: t("washTitle"), hint: t("washHint"), on: flags.wash, onToggle: function () { toggle("wash"); } }),
      h(Switch, { title: t("heroTitle"), hint: t("heroHint"), on: flags.hero, onToggle: function () { toggle("hero"); } }),
      h(Switch, { title: t("wmTitle"), hint: t("wmHint"), on: flags.watermark, onToggle: function () { toggle("watermark"); } }),
      h(Switch, { title: t("motionTitle"), hint: t("motionHint"), on: flags.motion, onToggle: function () { toggle("motion"); } }),
      h(Switch, { title: t("glassTitle"), hint: t("glassHint"), on: flags.glass, onToggle: function () { toggle("glass"); } })
    ),
    h("section", { className: "axzt-card" },
      h("h3", { className: "axzt-card-title" }, t("sectionComfort")),
      h("p", { className: "axzt-card-sub" }, t("comfortHint")),
      h(Slider, {
        label: t("washLevelLabel"), field: "washLevel", min: 0, max: 100, value: flags.washLevel, unit: "%",
        track: "linear-gradient(90deg,var(--dsw-alias-bg-layer-3,#fff)," +
          "var(--dsh-axzo-brand-soft,rgba(10,169,108,.2)))",
        onInput: function (_f, v) { patchFlags({ washLevel: v }); }
      }),
      h("button", { type: "button", className: "axzt-btn", onClick: lowStrain }, t("comfortPreset")),
      comfortNote === "" ? null : h("p", { className: "axzt-note" }, comfortNote)
    ),
    h("section", { className: "axzt-card" },
      h("h3", { className: "axzt-card-title" }, t("sbSection")),
      h("p", { className: "axzt-card-sub" }, t("sbHint")),
      h(Switch, { title: t("sbGlassTitle"), hint: t("sbGlassHint"), on: flags.sbGlass, onToggle: function () { toggle("sbGlass"); } }),
      h(Slider, {
        label: t("sbClearLabel"), field: "sbClear", min: 0, max: 100, value: flags.sbClear, unit: "%",
        track: "linear-gradient(90deg,var(--dsw-alias-bg-layer-3,#fff),var(--dsh-axzo-brand-soft,rgba(10,169,108,.2)))",
        onInput: function (_f, v) { patchFlags({ sbClear: v }); }
      }),
      h(Slider, {
        label: t("sbGrainLabel"), field: "sbGrain", min: 0, max: 100, value: flags.sbGrain, unit: "%",
        track: "linear-gradient(90deg,var(--dsw-alias-bg-layer-3,#fff),var(--dsw-alias-border-l2,rgba(0,0,0,.15)))",
        onInput: function (_f, v) { patchFlags({ sbGrain: v }); }
      }),
    ),
    h("section", { className: "axzt-card" },
      h(Preview, { t: t })
    )
  );
}
