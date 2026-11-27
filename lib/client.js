// dsh-qqbot 的浏览器半边：首页侧边栏「QQ 频道」面板 + 插件设置页。
// 数据通道：宿主 lib/host.js 挂载的 /qqbot-api/*（同源 HTTP，只监听本机）。
window.__ModuleLoader__.load({
  id: 'dsh-qqbot',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const SIDEBAR_PANEL_ID = 'qqbot'

    // 桌面壳里页面可能不是 http 源（可能是 file:// 或自定义协议），
    // 这时同源请求没有宿主服务，需要回到 127.0.0.1:<port>。
    function apiBases() {
      // 桌面壳的页面源是 dsh-app://app/，Electron 把该协议上除首页/静态资源之外的
      // 路径全部转发给宿主 HTTP 服务（并附带登录 cookie），所以「同源相对路径」
      // 在两种壳里都可用，必须放在第一位。
      const list = ['']
      const boot = (typeof window !== 'undefined' && window.__DSH_BOOT__) || {}
      const keys = ['webOrigin', 'origin', 'webserverOrigin', 'webUrl', 'url', 'baseUrl']
      for (const key of keys) {
        const value = boot[key]
        if (typeof value === 'string' && value.startsWith('http')) list.push(value.replace(/\/+$/, ''))
      }
      const port = boot.webPort || boot.port || boot.serverPort
      if (port) list.push('http://127.0.0.1:' + port)
      // 引导清单里的 bundle 地址有时是绝对的 http 地址，可以反推出宿主源。
      for (const group of [boot.entries, boot.batches]) {
        if (!Array.isArray(group)) continue
        for (const item of group) {
          const value = item && item.url
          if (typeof value !== 'string') continue
          const match = /^(https?:\/\/[^/]+)/.exec(value)
          if (match) list.push(match[1])
        }
      }
      list.push('http://127.0.0.1:54800')
      return list.filter((item, index) => list.indexOf(item) === index)
    }

    let baseCache = null

    const API = '/qqbot-api'

    async function api(path, init) {
      const bases = baseCache === null ? apiBases() : [baseCache]
      const errors = []
      for (const base of bases) {
        let res
        try {
          res = await fetch(base + API + path, init)
        } catch (error) {
          errors.push(base + ': ' + String(error && error.message ? error.message : error))
          if (base === baseCache) baseCache = null
          continue
        }
        baseCache = base
        const text = await res.text()
        let data
        try { data = text ? JSON.parse(text) : {} } catch { data = { ok: false, error: text.slice(0, 200) } }
        if (!res.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + res.status))
        return data
      }
      let page = ''
      try { page = String(location.href).slice(0, 120) } catch { /* ignore */ }
      throw new Error((errors.join('；') || '没有可用的宿主地址') + (page === '' ? '' : '（页面 ' + page + '）'))
    }

    async function apiGet(path) {
      return api(path, { method: 'GET', cache: 'no-store' })
    }

    async function apiPost(path, body) {
      return api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
    }

    const pad2 = (n) => String(n).padStart(2, '0')

    function timeOf(ms) {
      if (!ms) return ''
      const d = new Date(ms)
      return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
    }

    function agoOf(ms) {
      if (!ms) return ''
      const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
      if (s < 45) return '刚刚'
      if (s < 3600) return Math.round(s / 60) + ' 分钟前'
      if (s < 86400) return Math.round(s / 3600) + ' 小时前'
      return Math.round(s / 86400) + ' 天前'
    }

    function fmtTokens(n) {
      const value = Number(n) || 0
      if (value >= 1000000) return (value / 1000000).toFixed(2) + 'M'
      if (value >= 10000) return Math.round(value / 1000) + 'k'
      if (value >= 1000) return (value / 1000).toFixed(1) + 'k'
      return String(value)
    }

    // ───────────────────────── 样式 ─────────────────────────
    // 内联样式做不了 hover / focus / 过渡，所以统一注入一张样式表，
    // 组件只用 class，动态值（进度条宽度等）才走 style。
    const STYLE_ID = 'dsh-qqbot-panel-style'

    const PANEL_CSS = `
.qb-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;color:inherit;
  font:13px/1.62 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.qb-head{display:flex;align-items:center;gap:10px;padding:14px 18px 12px;flex:0 0 auto;
  border-bottom:1px solid rgba(255,255,255,.075)}
.qb-headtext{display:flex;flex-direction:column;gap:1px;min-width:0}
.qb-title{font-size:15px;font-weight:650;letter-spacing:.2px}
.qb-sub{font-size:11.5px;opacity:.55;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qb-headspacer{flex:1 1 auto}
.qb-body{display:flex;flex:1 1 auto;min-height:0}
.qb-nav{display:flex;flex-direction:column;gap:3px;padding:12px 8px;width:132px;flex:0 0 auto;
  border-right:1px solid rgba(255,255,255,.07);overflow-y:auto}
.qb-navitem{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:9px;border:1px solid transparent;
  background:transparent;color:inherit;font:inherit;font-size:12.5px;cursor:pointer;text-align:left;
  transition:background .16s,border-color .16s,transform .07s}
.qb-navitem:hover{background:rgba(255,255,255,.055)}
.qb-navitem:active{transform:scale(.985)}
.qb-navitem-on{background:rgba(122,162,247,.15);border-color:rgba(122,162,247,.38)}
.qb-navitem-on .qb-ic{color:#93b7ff}
.qb-navhint{margin:8px 4px 0;font-size:11px;opacity:.4;line-height:1.5}
.qb-main{flex:1 1 auto;min-width:0;overflow-y:auto;padding:14px 16px 30px;display:flex;flex-direction:column;gap:12px}
.qb-card{border:1px solid rgba(255,255,255,.085);border-radius:12px;background:rgba(255,255,255,.026);
  transition:border-color .2s,box-shadow .2s,background .2s}
.qb-card:hover{border-color:rgba(255,255,255,.16);box-shadow:0 6px 20px rgba(0,0,0,.16)}
.qb-carddirty{border-color:rgba(230,170,80,.42);background:rgba(230,170,80,.04)}
.qb-cardhead{display:flex;align-items:center;gap:9px;padding:11px 14px 5px}
.qb-cardhead .qb-ic{opacity:.75}
.qb-cardtitle{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 auto}
.qb-cardname{font-size:12.5px;font-weight:640;letter-spacing:.2px}
.qb-carddesc{font-size:11.5px;opacity:.5}
.qb-cardbody{padding:4px 14px 12px;display:flex;flex-direction:column;gap:9px}
.qb-cardfoot{display:flex;gap:8px;flex-wrap:wrap;padding:0 14px 13px}
.qb-ic{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto}
.qb-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.qb-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:9px}
.qb-field{display:flex;flex-direction:column;gap:3px;min-width:0}
.qb-flabel{font-size:11.5px;opacity:.62}
.qb-input{background:rgba(0,0,0,.18);border:1px solid rgba(255,255,255,.11);border-radius:8px;padding:6px 9px;
  color:inherit;font:inherit;min-width:0;width:100%;box-sizing:border-box;transition:border-color .16s,background .16s}
.qb-input:hover{border-color:rgba(255,255,255,.2)}
.qb-input:focus{outline:none;border-color:rgba(122,162,247,.75);background:rgba(122,162,247,.07)}
.qb-textarea{min-height:78px;resize:vertical;line-height:1.6}
.qb-mono{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:11.8px}
.qb-hint{font-size:11.5px;opacity:.52;line-height:1.55}
.qb-flabel .qb-slideval{float:right;font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:11.5px;
  color:rgba(122,162,247,.95);opacity:.95}
.qb-slider{-webkit-appearance:none;appearance:none;width:100%;height:4px;border-radius:2px;margin:7px 0 3px;
  background:rgba(255,255,255,.14);background-image:linear-gradient(90deg,rgba(122,162,247,.95),rgba(122,162,247,.55));
  background-repeat:no-repeat;background-size:50% 100%;cursor:pointer;outline:none}
.qb-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;border-radius:50%;
  background:#fff;border:2px solid rgba(122,162,247,.9);box-shadow:0 1px 4px rgba(0,0,0,.45);
  transition:transform .12s,box-shadow .12s}
.qb-slider:hover::-webkit-slider-thumb{transform:scale(1.15)}
.qb-slider:active::-webkit-slider-thumb{transform:scale(1.25);box-shadow:0 0 0 6px rgba(122,162,247,.18)}
.qb-hint-line{padding-left:2px;border-left:2px solid rgba(255,255,255,.1);padding:1px 0 1px 8px}
.qb-toggle{display:flex;align-items:flex-start;gap:9px}
.qb-sw{width:38px;height:21px;border-radius:11px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.09);
  position:relative;cursor:pointer;transition:background .18s,border-color .18s;padding:0;flex:0 0 auto;margin-top:1px}
.qb-sw:hover{border-color:rgba(255,255,255,.32)}
.qb-sw-on{background:rgba(122,162,247,.6);border-color:rgba(122,162,247,.85)}
.qb-knob{position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#fff;
  transition:transform .18s ease;box-shadow:0 1px 2px rgba(0,0,0,.35)}
.qb-sw-on .qb-knob{transform:translateX(17px)}
.qb-tgltext{display:flex;flex-direction:column;gap:1px;min-width:0}
.qb-tgllabel{font-size:12.5px}
.qb-btn{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:8px;
  border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.055);color:inherit;font:inherit;font-size:12.5px;
  cursor:pointer;transition:background .16s,border-color .16s,transform .07s,opacity .16s;white-space:nowrap}
.qb-btn:hover:not(:disabled){background:rgba(255,255,255,.11);border-color:rgba(255,255,255,.22)}
.qb-btn:active:not(:disabled){transform:translateY(1px)}
.qb-btn:disabled{opacity:.42;cursor:not-allowed}
.qb-primary{background:rgba(122,162,247,.2);border-color:rgba(122,162,247,.5);color:#cfe0ff}
.qb-primary:hover:not(:disabled){background:rgba(122,162,247,.32);border-color:rgba(122,162,247,.7)}
.qb-danger{background:rgba(224,112,112,.15);border-color:rgba(224,112,112,.45);color:#ffc9c9}
.qb-danger:hover:not(:disabled){background:rgba(224,112,112,.25)}
.qb-tile{display:flex;flex-direction:column;gap:2px;padding:9px 11px;border-radius:10px;
  border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);flex:1 1 110px;min-width:0}
.qb-tilev{font-size:16px;font-weight:640;letter-spacing:.2px}
.qb-tilek{font-size:11px;opacity:.5}
.qb-pill{font-size:10.5px;padding:1px 7px;border-radius:999px;border:1px solid rgba(255,255,255,.16);opacity:.85}
.qb-pill-ok{color:#8fe3b0;border-color:rgba(89,200,138,.45);background:rgba(89,200,138,.12)}
.qb-pill-warn{color:#f0c882;border-color:rgba(230,170,80,.45);background:rgba(230,170,80,.12)}
.qb-pill-err{color:#ffb3b3;border-color:rgba(224,112,112,.45);background:rgba(224,112,112,.12)}
.qb-dot{width:8px;height:8px;border-radius:4px;flex:0 0 auto}
.qb-dot-on{background:#59c88a;box-shadow:0 0 7px rgba(89,200,138,.7)}
.qb-dot-off{background:#e07070}
.qb-dot-unknown{background:#e0aa50}
.qb-bar{height:7px;border-radius:5px;background:rgba(255,255,255,.1);overflow:hidden;position:relative}
.qb-barfill{height:100%;border-radius:5px;transition:width .4s ease}
.qb-mark{position:absolute;top:-2px;bottom:-2px;width:1px;background:rgba(255,255,255,.35)}
.qb-spark{display:flex;align-items:flex-end;gap:2px;height:34px;padding:2px 0;overflow:hidden}
.qb-sparkbar{width:5px;flex:0 0 auto;border-radius:2px;background:rgba(122,162,247,.55);
  transition:height .3s ease,background .16s}
.qb-sparkbar:hover{background:rgba(150,185,255,.95)}
.qb-list{display:flex;flex-direction:column;gap:2px;max-height:200px;overflow-y:auto;padding-right:2px}
.qb-msg{display:flex;gap:8px;padding:4px 6px;border-radius:7px;transition:background .14s;align-items:flex-start}
.qb-msg:hover{background:rgba(255,255,255,.05)}
.qb-msgwho{font-size:11px;opacity:.5;flex:0 0 auto;font-variant-numeric:tabular-nums;padding-top:1px}
.qb-msgtext{word-break:break-word;opacity:.92;font-size:12.5px}
.qb-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;
  border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);font-size:12px;cursor:pointer;
  transition:background .16s,border-color .16s}
.qb-chip:hover{background:rgba(255,255,255,.09)}
.qb-chip-on{background:rgba(122,162,247,.18);border-color:rgba(122,162,247,.5)}
.qb-chips{display:flex;gap:6px;flex-wrap:wrap}
.qb-actions{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}
.qb-quick{display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding:10px 12px;border-radius:10px;
  border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03);color:inherit;font:inherit;cursor:pointer;
  transition:background .16s,transform .07s,border-color .16s;text-align:left}
.qb-quick:hover{background:rgba(122,162,247,.13);border-color:rgba(122,162,247,.4)}
.qb-quick:active{transform:translateY(1px)}
.qb-quick:disabled{opacity:.45;cursor:not-allowed}
.qb-quickk{font-size:12.5px;font-weight:600}
.qb-quickd{font-size:11px;opacity:.5}
.qb-toast{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);display:flex;align-items:center;gap:8px;
  padding:8px 14px;border-radius:999px;font-size:12.5px;max-width:min(560px,92%);z-index:30;
  box-shadow:0 10px 28px rgba(0,0,0,.4);animation:qbin .16s ease-out;backdrop-filter:blur(6px)}
.qb-toast-ok{background:rgba(40,90,62,.92);border:1px solid rgba(89,200,138,.6);color:#d8ffe7}
.qb-toast-err{background:rgba(98,42,42,.92);border:1px solid rgba(224,112,112,.6);color:#ffdede}
.qb-toast-busy{background:rgba(38,58,98,.92);border:1px solid rgba(122,162,247,.6);color:#dbe7ff}
.qb-toast-time{opacity:.6;font-size:11px}
.qb-spin{width:11px;height:11px;border-radius:50%;border:2px solid rgba(255,255,255,.28);border-top-color:#fff;
  animation:qbspin .7s linear infinite;flex:0 0 auto}
.qb-loading{position:relative;color:transparent!important}
.qb-loading>*{visibility:hidden}
.qb-loading::after{content:"";position:absolute;inset:0;margin:auto;width:12px;height:12px;border-radius:50%;
  border:2px solid rgba(255,255,255,.3);border-top-color:#fff;animation:qbspin .7s linear infinite}
.qb-empty{padding:14px;border-radius:10px;border:1px dashed rgba(255,255,255,.14);text-align:center;
  font-size:12px;opacity:.5}
.qb-err{color:#ffb3b3;font-size:12px}
.qb-result{padding:8px 10px;border-radius:9px;border:1px solid rgba(255,255,255,.1);background:rgba(0,0,0,.16);
  font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:11.5px;white-space:pre-wrap;
  max-height:180px;overflow:auto;line-height:1.5}
.qb-fadein{animation:qbfade .18s ease-out}
@keyframes qbspin{to{transform:rotate(360deg)}}
@keyframes qbin{from{opacity:0;transform:translate(-50%,6px)}to{opacity:1;transform:translate(-50%,0)}}
@keyframes qbfade{from{opacity:0}to{opacity:1}}
`

    function ensureStyle() {
      try {
        if (typeof document === 'undefined') return
        if (document.getElementById(STYLE_ID)) return
        const el = document.createElement('style')
        el.id = STYLE_ID
        el.textContent = PANEL_CSS
        document.head.appendChild(el)
      } catch { /* ignore */ }
    }

    // ───────────────────────── 基础组件 ─────────────────────────

    const ICON_PATHS = {
      link: 'M9.5 14.5 14.5 9.5M8 12l-1.6 1.6a3.4 3.4 0 0 0 4.8 4.8L12.8 17M16 12l1.6-1.6a3.4 3.4 0 0 0-4.8-4.8L11.2 7',
      chat: 'M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v6A2.5 2.5 0 0 1 17.5 15H12l-4 3.2V15H6.5A2.5 2.5 0 0 1 4 12.5z',
      mic: 'M12 4a2.5 2.5 0 0 1 2.5 2.5v4a2.5 2.5 0 0 1-5 0v-4A2.5 2.5 0 0 1 12 4zM6.5 10.5a5.5 5.5 0 0 0 11 0M12 16v3.5',
      brain: 'M7 5.5h10M7 12h10M7 18.5h10M5 5.5v13M19 5.5v13',
      wrench: 'M14.5 4a4.5 4.5 0 0 0-4.2 6.1L4 16.4 7.6 20l6.3-6.3A4.5 4.5 0 1 0 14.5 4z',
      bolt: 'M13 3 5 13.5h5L10 21l8-10.5h-5z',
      send: 'M4 12 20 4l-6.2 16-2.6-6.2z',
      refresh: 'M19 11a7 7 0 1 0-2.1 5M19 5v6h-6',
      save: 'M5 5h11l3 3v11H5zM8 5v5h7V5M8 19v-5h8v5',
      list: 'M5 7h14M5 12h14M5 17h9',
      image: 'M4 6h16v12H4zM8.5 10.5a1.2 1.2 0 1 0 0-.1M4 16l5-4 4 3 3-2 4 3',
      smile: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM9 10v.01M15 10v.01M8.6 14a4.4 4.4 0 0 0 6.8 0',
      eye: 'M3 12s3.6-6 9-6 9 6 9 6-3.6 6-9 6-9-6-9-6zM12 9.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z',
      memory: 'M6 4h12v16H6zM9 8h6M9 12h6M9 16h4',
      terminal: 'M4 5h16v14H4zM7.5 9.5l2.5 2.5-2.5 2.5M12.5 15H17',
      users: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2.5 19.5c0-2.8 2.5-4.5 5.5-4.5s5.5 1.7 5.5 4.5M16 5.5a2.6 2.6 0 0 1 0 5.2M17.5 15.2c2.4.4 4 2 4 4.3',
    }

    function Icon(props) {
      const size = props.size || 16
      const d = ICON_PATHS[props.name] || ICON_PATHS.chat
      return h('span', { className: 'qb-ic' },
        h('svg', {
          viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', {
          d, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        })))
    }

    function Btn(props) {
      const cls = 'qb-btn' + (props.variant ? ' qb-' + props.variant : '') + (props.busy ? ' qb-loading' : '')
      return h('button', {
        type: 'button', className: cls, disabled: props.disabled === true || props.busy === true,
        onClick: props.onClick, title: props.title || '',
      },
      props.icon ? h(Icon, { name: props.icon, size: 14 }) : null,
      props.children === undefined ? null : h('span', null, props.children))
    }

    function Toggle(props) {
      return h('div', { className: 'qb-toggle' },
        h('button', {
          type: 'button', role: 'switch', 'aria-checked': props.checked === true,
          className: 'qb-sw' + (props.checked === true ? ' qb-sw-on' : ''),
          onClick: () => props.onChange(props.checked !== true),
          disabled: props.disabled === true,
        }, h('span', { className: 'qb-knob' })),
        h('div', { className: 'qb-tgltext' },
          h('div', { className: 'qb-tgllabel' }, props.label),
          props.hint ? h('div', { className: 'qb-hint' }, props.hint) : null))
    }

    function Field(props) {
      const value = props.value === undefined || props.value === null ? '' : String(props.value)
      return h('label', { className: 'qb-field' },
        h('span', { className: 'qb-flabel' }, props.label),
        h('input', {
          className: 'qb-input' + (props.mono ? ' qb-mono' : ''),
          value, placeholder: props.placeholder || '',
          inputMode: props.numeric ? 'numeric' : undefined,
          onChange: (e) => props.onChange(e.target.value),
        }),
        props.hint ? h('span', { className: 'qb-hint' }, props.hint) : null)
    }

    function Slider(props) {
      const min = Number(props.min)
      const max = Number(props.max)
      const step = Number(props.step) || 0.05
      const raw = Number(props.value)
      const value = Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : min
      const percent = Math.round(((value - min) / (max - min || 1)) * 100)
      const shown = (Math.round(value * 100) / 100).toFixed(2).replace(/\.?0+$/, '')
      return h('label', { className: 'qb-field' },
        h('span', { className: 'qb-flabel' }, props.label,
          h('span', { className: 'qb-slideval' }, shown + (props.unit || ''))),
        h('input', {
          className: 'qb-slider', type: 'range', min, max, step, value,
          style: { backgroundSize: percent + '% 100%' },
          onChange: (e) => props.onChange(Number(e.target.value)),
        }),
        props.hint ? h('span', { className: 'qb-hint' }, props.hint) : null)
    }

    function Card(props) {
      return h('section', { className: 'qb-card' + (props.dirty ? ' qb-carddirty' : '') + ' qb-fadein' },
        h('header', { className: 'qb-cardhead' },
          props.icon ? h(Icon, { name: props.icon, size: 15 }) : null,
          h('div', { className: 'qb-cardtitle' },
            h('div', { className: 'qb-cardname' }, props.title),
            props.desc ? h('div', { className: 'qb-carddesc' }, props.desc) : null),
          props.dirty ? h('span', { className: 'qb-pill qb-pill-warn' }, '未保存') : null,
          props.badge ? h('span', { className: 'qb-pill' }, props.badge) : null),
        h('div', { className: 'qb-cardbody' }, props.children),
        props.footer ? h('div', { className: 'qb-cardfoot' }, props.footer) : null)
    }

    function Toast(props) {
      const t = props.toast
      if (!t) return null
      const cls = t.kind === 'ok' ? 'qb-toast qb-toast-ok' : t.kind === 'err' ? 'qb-toast qb-toast-err' : 'qb-toast qb-toast-busy'
      return h('div', { className: cls },
        t.kind === 'busy' ? h('span', { className: 'qb-spin' }) : h(Icon, { name: t.kind === 'ok' ? 'smile' : 'wrench', size: 14 }),
        h('span', null, t.text),
        h('span', { className: 'qb-toast-time' }, t.at))
    }

    function VoicePicker(props) {
      const value = props.value === undefined || props.value === null ? '' : String(props.value)
      const voices = Array.isArray(props.voices) ? props.voices : null
      const missing = voices !== null && value !== '' && !voices.includes(value)
      const options = voices === null ? [] : (missing ? voices.concat([value]) : voices)
      return h('div', { className: 'qb-field' },
        h('span', { className: 'qb-flabel' }, '系统音色（SAPI 备用引擎）'),
        h('div', { className: 'qb-row' },
          options.length > 0
            ? h('select', {
              className: 'qb-input', style: { flex: '1 1 160px' }, value,
              onChange: (e) => props.onChange(e.target.value),
            }, options.map((name) => h('option', { key: name, value: name }, name === value && missing ? name + '（本机没装）' : name)))
            : h('input', {
              className: 'qb-input', style: { flex: '1 1 160px' }, value, placeholder: 'Microsoft Huihui Desktop',
              onChange: (e) => props.onChange(e.target.value),
            }),
          h(Btn, { icon: 'refresh', busy: props.busy, onClick: props.onLoad }, voices === null ? '读取音色' : '刷新')),
        missing
          ? h('span', { className: 'qb-hint' }, '这个音色在本机不存在，发语音会失败；点「读取音色」换一个。')
          : (voices !== null && voices.length === 0 ? h('span', { className: 'qb-hint' }, '没读到任何本机音色（系统语音包可能缺失）。') : null))
    }

    function StatTile(props) {
      return h('div', { className: 'qb-tile' },
        h('div', { className: 'qb-tilev' }, props.value),
        h('div', { className: 'qb-tilek' }, props.label))
    }

    function ContextCard(props) {
      const data = props.data
      if (data === null || data === undefined) {
        return h(Card, { title: '上下文洞察', icon: 'brain' }, h('div', { className: 'qb-hint' }, '正在读取…'))
      }
      if (data.ok === false) {
        return h(Card, { title: '上下文洞察', icon: 'brain', desc: '读 QQ 会话自己的用量记录' },
          h('div', { className: 'qb-empty' }, '读不到上下文：' + String(data.error || '未知原因')))
      }
      const current = data.current
      const windowTokens = Number(data.contextWindow) || 0
      const pct = Math.max(0, Math.min(100, Number(data.pct) || 0))
      const barColor = pct >= 85
        ? 'linear-gradient(90deg,rgba(224,112,112,.95),rgba(255,150,150,.95))'
        : pct >= 70
          ? 'linear-gradient(90deg,rgba(230,170,80,.95),rgba(245,205,120,.95))'
          : 'linear-gradient(90deg,rgba(96,146,255,.95),rgba(140,180,255,.95))'
      const total = current ? Number(current.total) || 0 : 0
      const toolsTokens = (data.tools && data.tools.estTokens) || 0
      const historyTokens = (data.history && data.history.estTokens) || 0
      const rest = Math.max(0, total - toolsTokens - historyTokens)
      const requests = Array.isArray(data.requests) ? data.requests : []
      const peak = requests.reduce((max, item) => Math.max(max, Number(item.total) || 0), 0) || 1
      const totals = data.totals || {}
      const counts = data.counts || {}

      return h(Card, {
        title: '上下文洞察',
        icon: 'brain',
        desc: '这个 QQ 会话的窗口占用、构成与累计用量',
        badge: current ? pct + '%' : '暂无请求',
      },
      h('div', { className: 'qb-row' },
        h('div', { style: { flex: '1 1 auto', minWidth: 120 } },
          h('div', { className: 'qb-row', style: { justifyContent: 'space-between', marginBottom: 4 } },
            h('span', { className: 'qb-hint' }, current ? fmtTokens(total) + ' / ' + fmtTokens(windowTokens) : '还没有请求'),
            h('span', { className: 'qb-hint' }, (data.model || '?')))) ,
        h(Btn, { icon: 'refresh', busy: props.busy, onClick: props.onRefresh }, '刷新')),
      h('div', { className: 'qb-bar' },
        h('div', { className: 'qb-barfill', style: { width: Math.max(1.5, pct) + '%', background: barColor } }),
        h('div', { className: 'qb-mark', style: { left: '70%' } })),
      pct >= 70
        ? h('div', { className: 'qb-hint', style: { color: pct >= 85 ? '#ffb3b3' : '#f0c882' } },
          '窗口用到 ' + pct + '% 了：再聊下去 DSH 会把旧对话折成摘要，原话细节会变薄（要紧事记得让她记日记）。')
        : null,
      h('div', { className: 'qb-grid2' },
        h(StatTile, { value: (Number(totals.requests) || 0), label: '累计请求' }),
        h(StatTile, { value: fmtTokens(totals.inputTokens), label: '新增输入' }),
        h(StatTile, { value: fmtTokens(totals.cacheReadTokens) + ' · ' + (Number(totals.cacheHitRate) || 0) + '%', label: '缓存命中' }),
        h(StatTile, { value: fmtTokens(totals.outputTokens), label: '累计输出' })),
      h('div', { className: 'qb-hint qb-hint-line' },
        '构成估算：工具说明 ~' + fmtTokens(toolsTokens) + ' · 对话历史 ~' + fmtTokens(historyTokens) + ' · 系统提示与其余 ~' + fmtTokens(rest)),
      h('div', { className: 'qb-hint qb-hint-line' },
        (Number(counts.turns) || 0) + ' 回合 · ' + (Number(counts.steps) || 0) + ' 步 · ' +
        (Number(counts.userMessages) || 0) + ' 条你发的 · ' + (Number(counts.assistantMessages) || 0) + ' 条她回的 · ' +
        (Number(counts.toolCalls) || 0) + ' 次工具 · ' + (Number(counts.compactions) || 0) + ' 次压缩'),
      requests.length > 0
        ? h('div', null,
          h('div', { className: 'qb-hint', style: { marginBottom: 2 } }, '最近 ' + requests.length + ' 次请求的窗口大小'),
          h('div', { className: 'qb-spark' },
            requests.map((item, index) => h('div', {
              key: String(item.seq) + '-' + index,
              className: 'qb-sparkbar',
              title: '回合 ' + item.turn + ' · ' + fmtTokens(item.total) + ' tokens',
              style: { height: Math.max(3, Math.round(((Number(item.total) || 0) / peak) * 32)) + 'px' },
            }))))
        : null,
      h('div', { className: 'qb-hint' }, '完整图表在对话页右侧「上下文」标签（dsh-context）'))
    }

    // ───────────────────────── 主面板 ─────────────────────────

    const TABS = [
      { id: 'overview', label: '概览', icon: 'link' },
      { id: 'chat', label: '对话', icon: 'chat' },
      { id: 'media', label: '声音与表情', icon: 'mic' },
      { id: 'memory', label: '记忆', icon: 'memory' },
      { id: 'advanced', label: '安装与调试', icon: 'wrench' },
    ]

    function Panel() {
      ensureStyle()

      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [busyKey, setBusyKey] = useState('')
      const [draft, setDraft] = useState(null)
      const [groups, setGroups] = useState(null)
      const [voices, setVoices] = useState(null)
      const [insight, setInsight] = useState(null)
      const [voiceText, setVoiceText] = useState('')
      const [memoryView, setMemoryView] = useState(null)
      const [toast, setToast] = useState(null)
      const [touched, setTouched] = useState({})
      const [tab, setTab] = useState('overview')
      const [result, setResult] = useState('')
      const dirty = useRef(false)

      const toastTimer = useRef(null)
      const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false })
      const flash = (kind, text) => {
        setToast({ kind, text, at: stamp() })
        if (toastTimer.current) window.clearTimeout(toastTimer.current)
        toastTimer.current = window.setTimeout(() => setToast(null), 3000)
      }

      useEffect(() => () => {
        if (toastTimer.current) window.clearTimeout(toastTimer.current)
      }, [])

      const withBusy = async (key, fn) => {
        setBusyKey(key)
        try { return await fn() } finally { setBusyKey('') }
      }

      const refresh = useCallback(async (force) => {
        try {
          const data = await apiGet('/state')
          setState(data)
          if (force === true || dirty.current === false) setDraft(data.config)
          setError('')
        } catch (e) {
          setError(String(e.message || e))
        }
      }, [])

      useEffect(() => {
        void refresh(true)
        const t = window.setInterval(() => { void refresh(false) }, 8000)
        return () => window.clearInterval(t)
      }, [refresh])

      const set = (path, value) => {
        dirty.current = true
        const root = path.split('.')[0]
        setTouched((prev) => (prev[root] === true ? prev : Object.assign({}, prev, { [root]: true })))
        setDraft((prev) => {
          const next = JSON.parse(JSON.stringify(prev || {}))
          const parts = path.split('.')
          let node = next
          for (let i = 0; i < parts.length - 1; i++) {
            if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {}
            node = node[parts[i]]
          }
          node[parts[parts.length - 1]] = value
          return next
        })
      }

      const clearTouched = (keys) => {
        dirty.current = false
        setTouched((prev) => {
          const next = Object.assign({}, prev)
          for (const key of keys) delete next[key]
          return next
        })
      }

      const save = (key, patch, keys) => withBusy('save:' + key, async () => {
        flash('busy', '正在保存…')
        try {
          const body = patch && Object.keys(patch).length > 0 ? patch : buildPatch(draft)
          await apiPost('/config', { patch: body })
          clearTouched(keys)
          flash('ok', '已保存')
          await refresh(true)
        } catch (e) {
          setError(String(e.message || e))
          flash('err', '保存失败：' + String(e.message || e))
        }
      })

      const act = (key, action, extra, okText) => withBusy('act:' + key, async () => {
        flash('busy', action === 'sendVoice' ? '正在合成语音（首次约 30 秒）…' : '正在执行…')
        try {
          const data = await apiPost('/action', Object.assign({ action }, extra || {}))
          flash('ok', (okText || '已发送') + (data.messageId ? '（id ' + data.messageId + '）' : ''))
          if (action === 'pluginList') {
            const names = Array.isArray(data.enabled) ? data.enabled : []
            setResult('已启用插件（' + names.length + '）：\n' + names.join('\n'))
          }
          await refresh(false)
        } catch (e) {
          setError(String(e.message || e))
          flash('err', '失败：' + String(e.message || e))
        }
      })

      const loadGroups = () => withBusy('load:groups', async () => {
        flash('busy', '正在读取群列表…')
        try {
          const data = await apiGet('/groups')
          setGroups(data)
          flash('ok', '群列表已更新')
        } catch (e) {
          setError(String(e.message || e))
          flash('err', '读取群列表失败：' + String(e.message || e))
        }
      })

      const loadVoices = () => withBusy('load:voices', async () => {
        flash('busy', '正在读取本机音色…')
        try {
          const data = await apiGet('/voices')
          setVoices(Array.isArray(data.voices) ? data.voices : [])
          flash('ok', '音色列表已更新')
        } catch (e) {
          setError(String(e.message || e))
          flash('err', '读取音色失败：' + String(e.message || e))
        }
      })

      const loadMemory = (date) => withBusy('load:memory', async () => {
        flash('busy', '正在读日记…')
        try {
          const data = await apiGet('/memory' + (date ? '?date=' + encodeURIComponent(date) : ''))
          if (data.ok !== true) throw new Error(data.error || '读取失败')
          setMemoryView(data)
          flash('ok', '已读取 ' + data.date + (data.diary === '' ? '（还没有日记）' : ' 的日记'))
        } catch (e) {
          setError(String(e.message || e))
          flash('err', '读取日记失败：' + String(e.message || e))
        }
      })

      const ownerQq = (state && state.config && state.config.owner && state.config.owner.qq) || ''
      const loadInsight = useCallback(async () => {
        if (ownerQq === '') {
          setInsight({ ok: false, error: '还没设置主人 QQ' })
          return
        }
        try {
          const data = await apiGet('/context?id=' + encodeURIComponent('private:' + ownerQq))
          setInsight(data)
        } catch (e) {
          setInsight({ ok: false, error: String(e.message || e) })
        }
      }, [ownerQq])

      useEffect(() => {
        void loadInsight()
        const t = window.setInterval(() => { void loadInsight() }, 8000)
        return () => window.clearInterval(t)
      }, [loadInsight])

      if (draft === null) {
        return h('div', { className: 'qb-root' },
          h('div', { className: 'qb-head' },
            h(Icon, { name: 'chat', size: 18 }),
            h('div', { className: 'qb-headtext' },
              h('div', { className: 'qb-title' }, 'QQ 频道'),
              h('div', { className: 'qb-sub' }, error !== '' ? '面板接口不可用：' + error : '正在读取配置…'))))
      }

      const status = (state && state.status) || {}
      const recent = status.recent || []
      const cfg = draft
      const owner = cfg.owner || {}
      const proactive = cfg.proactive || {}
      const voice = cfg.voice || {}
      const meme = cfg.meme || {}
      const memory = cfg.memory || {}
      const debug = cfg.debug || {}
      const image = cfg.image || {}
      const send = cfg.send || {}
      const reply = cfg.reply || {}
      const allowGroups = cfg.allowGroups || []
      const connected = status.connected === true
      const isDirty = (keys) => keys.some((k) => touched[k] === true)
      const busy = busyKey !== ''

      // ── 概览 ──
      const overview = [
        h(Card, {
          key: 'status',
          title: '连接状态',
          icon: 'link',
          badge: connected ? '在线' : '离线',
          desc: status.lastEventAt ? '最近消息 ' + agoOf(status.lastEventAt) : '还没有收到过消息',
          footer: [
            h(Btn, { key: 'r', icon: 'refresh', busy: busyKey === 'act:reconnect', disabled: busy, onClick: () => act('reconnect', 'reconnect', {}, '已重连') }, '重连'),
            h(Btn, { key: 's', icon: 'list', onClick: () => void refresh(true) }, '刷新状态'),
          ],
        },
        h('div', { className: 'qb-row' },
          h('span', { className: connected ? 'qb-dot qb-dot-on' : 'qb-dot qb-dot-off' }),
          h('span', null, connected ? 'OpenQQ 已连接' : '未连上 OpenQQ'),
          h('span', { className: 'qb-pill' }, 'QQ ' + (status.selfId || cfg.selfId || '?')),
          h('span', { className: 'qb-pill' }, '主人 ' + (owner.qq || '未设置'))),
        h('div', { className: 'qb-hint qb-hint-line' }, '接口 ' + (cfg.ws && cfg.ws.url ? cfg.ws.url : '(未配置)')),
        status.lastError ? h('div', { className: 'qb-err' }, '最近错误：' + status.lastError) : null,
        h('div', { className: 'qb-hint' }, '配置：' + (status.configPath || '~/.dsh/qqbot.json'))),

        h(Card, { key: 'quick', title: '快捷动作', icon: 'bolt', desc: '点一下就发到 QQ，不用等她' },
          h('div', { className: 'qb-actions' },
            h('button', {
              className: 'qb-quick', disabled: busy,
              onClick: () => act('testText', 'sendText', { text: '在的，面板点一下就发出来了。' }, '测试消息已发'),
            }, h('span', { className: 'qb-quickk' }, '发条测试消息'), h('span', { className: 'qb-quickd' }, '确认链路通不通')),
            h('button', {
              className: 'qb-quick', disabled: busy,
              onClick: () => act('testFace', 'sendFace', { id: '178' }, '表情已发'),
            }, h('span', { className: 'qb-quickk' }, '发个表情'), h('span', { className: 'qb-quickd' }, 'QQ 自带表情 178')),
            h('button', {
              className: 'qb-quick', disabled: busy,
              onClick: () => act('testPoke', 'poke', {}, '戳了一下'),
            }, h('span', { className: 'qb-quickk' }, '戳一戳'), h('span', { className: 'qb-quickd' }, '轻轻提醒她')),
            h('button', {
              className: 'qb-quick', disabled: busy,
              onClick: () => act('testProactive', 'proactive', {}, '已让她主动发一条'),
            }, h('span', { className: 'qb-quickk' }, '主动一次'), h('span', { className: 'qb-quickd' }, '立刻触发主动搭话')))),
      ]

      const overviewTail = [
        h(ContextCard, { key: 'ctx', data: insight, busy: busyKey === 'load:insight', onRefresh: () => { void loadInsight() } }),
        h(Card, { key: 'recent', title: '最近对话', icon: 'chat', badge: recent.length > 0 ? recent.length + ' 条' : null },
          recent.length === 0
            ? h('div', { className: 'qb-empty' }, '这段时间还没有消息经过')
            : h('div', { className: 'qb-list' }, recent.map((m, i) => h('div', { key: i, className: 'qb-msg' },
              h('span', { className: 'qb-msgwho' }, timeOf(m.at) + (m.direction === 'in' ? '  ←' : '  →')),
              h('span', { className: 'qb-msgtext' }, m.text)))),
          h('div', { className: 'qb-hint' }, '← 她收到的 · → 她发出的')),
      ]

      // ── 对话 ──
      const chat = [
        h(Card, {
          key: 'owner', title: '聊天对象', icon: 'users',
          dirty: isDirty(['owner']),
          desc: '只有这个 QQ 号算「主人」，其他私聊按 allowPrivate 处理',
          footer: h(Btn, { variant: 'primary', icon: 'save', busy: busyKey === 'save:owner', disabled: busy, onClick: () => save('owner', { owner }, ['owner']) }, '保存'),
        },
        h(Field, {
          label: '主人 QQ', value: owner.qq, mono: true, placeholder: '例如 1194161232', numeric: true,
          onChange: (v) => set('owner.qq', v.replace(/[^0-9]/g, '')),
        }),
        h(Field, {
          label: '怎么称呼', value: owner.name, placeholder: '主人 / 你',
          onChange: (v) => set('owner.name', v),
        })),

        h(Card, {
          key: 'proactive', title: '主动搭话', icon: 'bolt',
          dirty: isDirty(['proactive']),
          desc: '她自己挑时间来找你，只在概率命中且不在安静时段时发生',
          badge: proactive.enabled === true ? '开' : '关',
          footer: [
            h(Btn, { key: 'a', variant: 'primary', icon: 'save', busy: busyKey === 'save:proactive', disabled: busy, onClick: () => save('proactive', { proactive }, ['proactive']) }, '保存'),
            h(Btn, { key: 'b', icon: 'send', busy: busyKey === 'act:testProactive', disabled: busy, onClick: () => act('testProactive', 'proactive', {}, '已让她主动发一条') }, '现在就试一次'),
          ],
        },
        h(Toggle, {
          label: '允许它自己找你说话', checked: proactive.enabled === true,
          onChange: (v) => set('proactive.enabled', v),
        }),
        h('div', { className: 'qb-grid2' },
          h(Field, {
            label: '多久一次（分钟）', value: proactive.everyMinutes, numeric: true, placeholder: '60',
            onChange: (v) => set('proactive.everyMinutes', Number(v.replace(/[^0-9]/g, '')) || 1),
          }),
          h(Field, {
            label: '真的开口的概率（%）', value: Math.round((Number(proactive.chance) || 0) * 100), numeric: true, placeholder: '30',
            onChange: (v) => set('proactive.chance', Math.max(0, Math.min(100, Number(v.replace(/[^0-9]/g, '')) || 0)) / 100),
          }),
          h(Field, {
            label: '安静时段（起）', value: (proactive.quietHours && proactive.quietHours[0]) || '00:30',
            onChange: (v) => set('proactive.quietHours', [v, (proactive.quietHours && proactive.quietHours[1]) || '08:00']),
          }),
          h(Field, {
            label: '安静时段（止）', value: (proactive.quietHours && proactive.quietHours[1]) || '08:00',
            onChange: (v) => set('proactive.quietHours', [(proactive.quietHours && proactive.quietHours[0]) || '00:30', v]),
          }),
          h(Field, {
            label: '每天最多几次', value: proactive.maxPerDay, numeric: true, placeholder: '8',
            onChange: (v) => set('proactive.maxPerDay', Number(v.replace(/[^0-9]/g, '')) || 1),
          }))),

        h(Card, {
          key: 'reply', title: '回复节奏', icon: 'chat',
          dirty: isDirty(['reply', 'send']),
          desc: '先攒一批、再随机等一会儿、一次回完',
          footer: h(Btn, {
            variant: 'primary', icon: 'save', busy: busyKey === 'save:reply', disabled: busy,
            onClick: () => save('reply', {
              reply, send: {
                maxChars: send.maxChars, replyMaxChars: send.replyMaxChars, maxSentences: send.maxSentences,
                forbidFaces: send.forbidFaces, facesEnabled: send.facesEnabled,
              },
            }, ['reply', 'send']),
          }, '保存'),
        },
        h('div', { className: 'qb-grid2' },
          h(Field, {
            label: '最短间隔（秒）', value: reply.minDelaySec, numeric: true, placeholder: '3',
            onChange: (v) => set('reply.minDelaySec', Math.min(600, Number(v.replace(/[^0-9]/g, '')) || 0)),
          }),
          h(Field, {
            label: '最长间隔（秒）', value: reply.maxDelaySec, numeric: true, placeholder: '12',
            onChange: (v) => set('reply.maxDelaySec', Math.min(600, Number(v.replace(/[^0-9]/g, '')) || 0)),
          }),
          h(Field, {
            label: '合并窗口（秒）', value: reply.batchWindowSec, numeric: true, placeholder: '8',
            hint: '这期间连发的消息会攒成一批',
            onChange: (v) => set('reply.batchWindowSec', Math.min(300, Number(v.replace(/[^0-9]/g, '')) || 0)),
          }),
          h(Field, {
            label: '单条最长字数', value: send.replyMaxChars, numeric: true, placeholder: '90',
            onChange: (v) => set('send.replyMaxChars', Math.min(1000, Number(v.replace(/[^0-9]/g, '')) || 0)),
          }),
          h(Field, {
            label: '最多几句', value: send.maxSentences, numeric: true, placeholder: '3',
            onChange: (v) => set('send.maxSentences', Math.min(10, Number(v.replace(/[^0-9]/g, '')) || 0)),
          })),
        h('div', { className: 'qb-hint qb-hint-line' },
          '两个间隔都设 0 就是立刻回。字数/句数是硬上限，超了在句子边界截断；你明确让她「详细讲」时当轮放宽三倍。')),

        h(Card, {
          key: 'group', title: '群聊', icon: 'users',
          dirty: isDirty(['groupRequireMention', 'allowGroups']),
          desc: '不勾任何群 = 所有群都能拉她进去',
          footer: h(Btn, { variant: 'primary', icon: 'save', busy: busyKey === 'save:group', disabled: busy, onClick: () => save('group', { groupRequireMention: cfg.groupRequireMention, allowGroups: cfg.allowGroups }, ['groupRequireMention', 'allowGroups']) }, '保存'),
        },
        h(Toggle, {
          label: '群里被 @ 才回应', checked: cfg.groupRequireMention !== false,
          onChange: (v) => set('groupRequireMention', v),
        }),
        h('div', { className: 'qb-row' },
          h(Btn, { icon: 'refresh', busy: busyKey === 'load:groups', disabled: busy, onClick: () => void loadGroups() }, '读取我的群'),
          h('span', { className: 'qb-hint' }, groups ? '点选允许它进哪些群' : '还没读取群列表')),
        groups
          ? h('div', { className: 'qb-chips' },
            (groups.groups || []).map((g) => {
              const id = String(g.group_id)
              const on = allowGroups.map(String).includes(id)
              return h('button', {
                key: id, type: 'button', className: 'qb-chip' + (on ? ' qb-chip-on' : ''),
                onClick: () => {
                  const list = allowGroups.map(String).filter((x) => x !== id)
                  if (!on) list.push(id)
                  set('allowGroups', list)
                },
              }, h(Icon, { name: on ? 'smile' : 'chat', size: 13 }), String(g.group_name || id) + ' · ' + id)
            }))
          : null),

        h(Card, {
          key: 'persona', title: 'QQ 专属人设补充', icon: 'chat',
          dirty: isDirty(['personaNote']),
          desc: '全局人格卡在 设置 → Soul；这里只写「在 QQ 上」的额外要求',
          footer: h(Btn, { variant: 'primary', icon: 'save', busy: busyKey === 'save:persona', disabled: busy, onClick: () => save('persona', { personaNote: cfg.personaNote }, ['personaNote']) }, '保存人设'),
        },
        h('textarea', {
          className: 'qb-input qb-textarea', value: String(cfg.personaNote || ''),
          placeholder: '例：跟主人说话短句、爱用「啧」，被夸会嘴上否认但尾巴翘起来。',
          onChange: (e) => set('personaNote', e.target.value),
        })),
      ]

      // ── 声音与表情 ──
      const media = [
        h(Card, {
          key: 'voice', title: '语音', icon: 'mic',
          dirty: isDirty(['voice']),
          badge: voice.enabled === true ? '开' : '关',
          desc: '克隆声线（IndexTTS）+ 系统音色兜底',
          footer: [
            h(Btn, { key: 'a', variant: 'primary', icon: 'save', busy: busyKey === 'save:voice', disabled: busy, onClick: () => save('voice', { voice }, ['voice']) }, '保存'),
            h(Btn, {
              key: 'b', icon: 'send', busy: busyKey === 'act:sendVoice', disabled: busy,
              onClick: () => act('sendVoice', 'sendVoice', { text: '喂，能听见吗？这是我在面板上点出来的语音。' }, '试听语音已发'),
            }, '试听一条'),
          ],
        },
        h(Toggle, {
          label: '允许它发语音消息', checked: voice.enabled === true,
          onChange: (v) => set('voice.enabled', v),
        }),
        h('div', { className: 'qb-grid2' },
          h(Field, {
            label: '合成引擎', value: voice.engine || 'clone', mono: true, placeholder: 'clone 或 sapi',
            hint: 'clone = 克隆声线；sapi = 系统音色（失败时自动退回）',
            onChange: (v) => set('voice.engine', String(v).trim() === 'sapi' ? 'sapi' : 'clone'),
          }),
          h(Field, {
            label: '一段最多几个字', value: voice.maxChars, numeric: true, placeholder: '60',
            onChange: (v) => set('voice.maxChars', Number(v.replace(/[^0-9]/g, '')) || 60),
          }),
          h(Field, {
            label: '语音最长秒数', value: voice.maxSeconds, numeric: true, placeholder: '12',
            onChange: (v) => set('voice.maxSeconds', Number(String(v).replace(/[^0-9.]/g, '')) || 12),
          })),
        h('div', { className: 'qb-hint qb-hint-line' }, '两个上限都生效：先按字数裁，合成后超过秒数就再压短重合成，还超就硬裁。'),
        h('div', { className: 'qb-grid2' },
          h(Slider, {
            label: '语速', value: voice.speed === undefined ? 1 : voice.speed, min: 0.6, max: 1.6, step: 0.05, unit: 'x',
            hint: '1.00 = 原速；往左更慢、往右更快',
            onChange: (v) => set('voice.speed', v),
          }),
          h(Slider, {
            label: '语调', value: voice.pitchSemitones === undefined ? 0 : voice.pitchSemitones, min: -6, max: 6, step: 0.5, unit: ' 半音',
            hint: '每 +1 升高一个半音，负数是压低；±12 才是一个八度',
            onChange: (v) => set('voice.pitchSemitones', v),
          })),
        h('div', { className: 'qb-hint qb-hint-line' }, '语速和语调靠 ffmpeg 后处理：变调不改变时长，变速不改音高。改完点「保存」，再用「试听一条」听效果。'),
        h(Field, {
          label: 'ffmpeg 路径（留空自动找）', value: voice.ffmpeg, mono: true, placeholder: 'C:\\Users\\86182\\.dsh\\bili-whale\\bin\\ffmpeg.exe',
          hint: '找不到 ffmpeg 时语速/语调会静默跳过，日志里会提醒',
          onChange: (v) => set('voice.ffmpeg', String(v).trim()),
        }),
        h(Field, {
          label: '克隆脚本 say.py', value: voice.cloneScript, mono: true, placeholder: 'D:\\DSH\\voice\\say.py',
          onChange: (v) => set('voice.cloneScript', String(v).trim()),
        }),
        h(Field, {
          label: '克隆用 Python', value: voice.clonePython, mono: true, placeholder: 'D:\\DSH\\voice\\venv\\Scripts\\python.exe',
          onChange: (v) => set('voice.clonePython', String(v).trim()),
        }),
        h(Field, {
          label: '参考音频', value: voice.cloneRef, mono: true, placeholder: 'D:\\DSH\\voice\\ref\\ref.wav',
          onChange: (v) => set('voice.cloneRef', String(v).trim()),
        }),
        h(VoicePicker, {
          value: voice.voiceName, voices, busy: busyKey === 'load:voices',
          onChange: (v) => set('voice.voiceName', v), onLoad: () => void loadVoices(),
        }),
        h('div', { className: 'qb-row' },
          h('input', {
            className: 'qb-input', style: { flex: '1 1 220px' }, value: voiceText,
            placeholder: '在这儿打一句，点右边用克隆声线发出去',
            onChange: (e) => setVoiceText(e.target.value),
          }),
          h(Btn, {
            variant: 'primary', icon: 'send', busy: busyKey === 'act:voiceText',
            disabled: busy || voiceText.trim() === '',
            onClick: () => act('voiceText', 'sendVoice', { text: voiceText.trim() }, '语音已发'),
          }, '发这条'))),

        h(Card, {
          key: 'meme', title: '表情包', icon: 'smile',
          dirty: isDirty(['meme']),
          badge: status.meme ? status.meme.used + '/' + status.meme.limit : null,
          desc: '文件名就是表情名，她自己按场合挑',
          footer: [
            h(Btn, { key: 'a', icon: 'send', busy: busyKey === 'act:sendMeme', disabled: busy, onClick: () => act('sendMeme', 'sendMeme', { key: '' }, '表情包已发') }, '随便发一张'),
            h(Btn, { key: 'b', variant: 'primary', icon: 'save', busy: busyKey === 'save:meme', disabled: busy, onClick: () => save('meme', { meme }, ['meme']) }, '保存'),
          ],
        },
        h(Toggle, { label: '让它能发表情包', checked: meme.enabled === true, onChange: (v) => set('meme.enabled', v) }),
        h('div', { className: 'qb-grid2' },
          h(Field, {
            label: '每天最多几张', value: meme.dailyLimit, numeric: true, placeholder: '10',
            onChange: (v) => set('meme.dailyLimit', Number(v.replace(/[^0-9]/g, '')) || 0),
          }),
          h(Field, {
            label: '表情包目录', value: meme.dir, mono: true, placeholder: 'C:\\Users\\86182\\Desktop\\meme',
            onChange: (v) => set('meme.dir', v),
          }))),

        h(Card, {
          key: 'image', title: '识图与表情开关', icon: 'image',
          dirty: isDirty(['image', 'send']),
          desc: '图片会作为图片直接附进消息，她是真能看见的',
          footer: h(Btn, {
            variant: 'primary', icon: 'save', busy: busyKey === 'save:image', disabled: busy,
            onClick: () => save('image', {
              image, send: { maxChars: send.maxChars, forbidFaces: send.forbidFaces, facesEnabled: send.facesEnabled },
            }, ['image', 'send']),
          }, '保存'),
        },
        h(Toggle, { label: '让它能看图片 / 动图', checked: image.enabled === true, onChange: (v) => set('image.enabled', v) }),
        h(Toggle, {
          label: '允许 QQ 自带表情', checked: send.facesEnabled === true,
          hint: '主人要求关闭：关掉后所有 [face:ID] 都会被拦掉',
          onChange: (v) => set('send.facesEnabled', v),
        }),
        h(Field, {
          label: '额外屏蔽的表情 ID（逗号分隔）', value: (send.forbidFaces || []).join(','), placeholder: '179',
          onChange: (v) => set('send.forbidFaces', v.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)),
        })),
      ]

      // ── 记忆 ──
      const memoryTab = [
        h(Card, {
          key: 'memory', title: '记忆与日记', icon: 'memory',
          dirty: isDirty(['memory']),
          badge: memory.enabled === false ? '关' : '开',
          desc: '每天流水 + 每晚日记，第二天按关键词自动回想',
          footer: [
            h(Btn, { key: 'a', icon: 'save', busy: busyKey === 'save:memory', disabled: busy, onClick: () => save('memory', { memory }, ['memory']) }, '保存'),
            h(Btn, { key: 'b', icon: 'chat', busy: busyKey === 'act:diaryNow', disabled: busy, onClick: () => act('diaryNow', 'diaryNow', {}, '已让她去写日记') }, '现在写今天的日记'),
            h(Btn, { key: 'c', variant: 'primary', icon: 'eye', busy: busyKey === 'load:memory', disabled: busy, onClick: () => void loadMemory() }, '看今天的日记'),
          ],
        },
        h(Toggle, {
          label: '打开长期记忆', checked: memory.enabled !== false,
          hint: '关掉后不记流水、不写日记、不自动回想',
          onChange: (v) => set('memory.enabled', v),
        }),
        h('div', { className: 'qb-grid2' },
          h(Field, {
            label: '日记时间（时）', value: memory.diaryHour, numeric: true, placeholder: '23',
            onChange: (v) => set('memory.diaryHour', Math.min(23, Number(v.replace(/[^0-9]/g, '')) || 0)),
          }),
          h(Field, {
            label: '日记时间（分）', value: memory.diaryMinute, numeric: true, placeholder: '30',
            onChange: (v) => set('memory.diaryMinute', Math.min(59, Number(v.replace(/[^0-9]/g, '')) || 0)),
          }),
          h(Field, {
            label: '回忆范围（天）', value: memory.recallDays, numeric: true, placeholder: '30',
            onChange: (v) => set('memory.recallDays', Math.min(365, Number(v.replace(/[^0-9]/g, '')) || 1)),
          })),
        h(Field, {
          label: '日记风格（人设）', value: memory.diaryStyle, placeholder: '冷一点、话短、不总结…',
          onChange: (v) => set('memory.diaryStyle', v),
        }),
        h('div', { className: 'qb-hint qb-hint-line' },
          '她说的每句话都会记进当天流水；到点让她写一篇日记（今天发生了什么、细节、心情）。你提到关键词时系统会自动把相关记忆塞回去，她自己也能用 qq_recall 搜。'),
        memoryView === null
          ? null
          : h('div', { className: 'qb-result' },
            memoryView.diary === ''
              ? memoryView.date + ' 还没有日记。当天流水：\n' + (memoryView.dayLines || '（空）')
              : memoryView.date + ' 的日记：\n' + memoryView.diary)),
      ]

      // ── 安装与调试 ──
      const advanced = [
        h(Card, {
          key: 'debug', title: '安装与调试', icon: 'terminal',
          dirty: isDirty(['debug']),
          badge: debug.enabled === false ? '关' : '开',
          desc: '她可以自己装插件、跑命令查日志、改文件止血',
          footer: [
            h(Btn, { key: 'a', icon: 'list', busy: busyKey === 'act:pluginList', disabled: busy, onClick: () => act('pluginList', 'pluginList', {}, '已读取插件列表') }, '看装了哪些插件'),
            h(Btn, { key: 'b', variant: 'primary', icon: 'save', busy: busyKey === 'save:debug', disabled: busy, onClick: () => save('debug', { debug }, ['debug']) }, '保存'),
          ],
        },
        h(Toggle, {
          label: '允许她在 QQ 上装插件、跑命令、读写文件', checked: debug.enabled !== false,
          hint: '关掉后 qq_plugin_* / qq_shell / qq_read_file / qq_write_file 都会拒绝执行',
          onChange: (v) => set('debug.enabled', v),
        }),
        h('div', { className: 'qb-grid2' },
          h(Field, {
            label: '命令超时（毫秒）', value: debug.shellTimeoutMs, numeric: true, placeholder: '120000',
            onChange: (v) => set('debug.shellTimeoutMs', Math.max(1000, Number(v.replace(/[^0-9]/g, '')) || 120000)),
          }),
          h(Field, {
            label: '返回最多字符', value: debug.maxOutputChars, numeric: true, placeholder: '4000',
            onChange: (v) => set('debug.maxOutputChars', Math.max(500, Number(v.replace(/[^0-9]/g, '')) || 4000)),
          })),
        h(Toggle, {
          label: '允许她改文件（改前自动备份 .bak）', checked: !debug || debug.allowWrite !== false,
          onChange: (v) => set('debug.allowWrite', v),
        }),
        h('div', { className: 'qb-hint qb-hint-line' },
          '她能用的工具：qq_plugin_install（你把插件链接甩给她）、qq_plugin_list / qq_plugin_set、qq_shell、qq_read_file / qq_write_file。'),
        result === '' ? null : h('div', { className: 'qb-result' }, result)),

        h(Card, {
          key: 'conninfo', title: '连接参数', icon: 'link',
          desc: '这些在 ~/.dsh/qqbot.json 里，面板只读不写',
        },
        h('div', { className: 'qb-grid2' },
          h(Field, { label: 'OpenQQ 地址', value: (cfg.ws && cfg.ws.url) || '', mono: true, onChange: () => {} }),
          h(Field, { label: '机器人 QQ', value: cfg.selfId || status.selfId || '', mono: true, onChange: () => {} }),
          h(Field, { label: '工作目录', value: cfg.workspace || '', mono: true, onChange: () => {} }),
          h(Field, { label: '配置文件', value: status.configPath || '', mono: true, onChange: () => {} }))),
      ]

      const bodyByTab = { overview: overview.concat(overviewTail), chat, media, memory: memoryTab, advanced }

      return h('div', { className: 'qb-root' },
        h('header', { className: 'qb-head' },
          h(Icon, { name: 'chat', size: 18 }),
          h('div', { className: 'qb-headtext' },
            h('div', { className: 'qb-title' }, 'QQ 频道'),
            h('div', { className: 'qb-sub' },
              (connected ? '已连 OpenQQ' : '未连接') + ' · QQ ' + (status.selfId || cfg.selfId || '?') +
              (status.lastEventAt ? ' · ' + agoOf(status.lastEventAt) : '') + ' · 8 秒自动刷新')),
          h('div', { className: 'qb-headspacer' }),
          h('span', { className: connected ? 'qb-pill qb-pill-ok' : 'qb-pill qb-pill-err' }, connected ? '在线' : '离线')),

        h('div', { className: 'qb-body' },
          h('nav', { className: 'qb-nav' },
            TABS.map((t) => h('button', {
              key: t.id, type: 'button',
              className: 'qb-navitem' + (tab === t.id ? ' qb-navitem-on' : ''),
              onClick: () => setTab(t.id),
            }, h(Icon, { name: t.icon, size: 15 }), h('span', null, t.label))),
            h('div', { className: 'qb-navhint' }, '改完记得点卡片里的「保存」')),

          h('main', { className: 'qb-main' }, bodyByTab[tab] || [])),

        h(Toast, { toast }),
        error !== '' ? h('div', { className: 'qb-err', style: { padding: '0 16px 12px' } }, error) : null)
    }

    function buildPatch(draft) {
      return {
        owner: draft.owner,
        proactive: draft.proactive,
        voice: draft.voice,
        groupRequireMention: draft.groupRequireMention,
        allowGroups: draft.allowGroups,
        allowPrivate: draft.allowPrivate,
        personaNote: draft.personaNote,
      }
    }

    function SidebarIcon() {
      return h('svg', {
        viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': true,
        style: { display: 'block' },
      },
      h('path', {
        d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v7A2.5 2.5 0 0 1 17.5 15H12l-4.2 3.4c-.6.5-1.3 0-1.3-.7V15C5.1 14.6 4 13.5 4 12z',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round',
      }),
      h('circle', { cx: 9, cy: 9, r: 1.15, fill: 'currentColor' }),
      h('circle', { cx: 15, cy: 9, r: 1.15, fill: 'currentColor' }))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main', key: SIDEBAR_PANEL_ID,
          }, Panel))
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist', id: SIDEBAR_PANEL_ID, order: 20,
            label: () => 'QQ 频道',
          }, SidebarIcon))
          ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
            name: 'plugins.bundle.config', key: 'dsh-qqbot',
          }, (props) => {
            if (props && props.view === 'summary') return 'QQ 频道：把 DeepSeek Harness 接到 QQ（OpenQQ / OneBot v11），可调主人、表情、语音与主动搭话。'
            return h(Panel, props)
          }))
        } catch (error) {
          try { console.error('[dsh-qqbot] 面板注册失败', error) } catch { /* ignore */ }
        }
      },
    }
  },
})
