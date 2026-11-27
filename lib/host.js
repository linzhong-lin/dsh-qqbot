/**
 * dsh-qqbot — a compact QQ channel for DeepSeek Harness.
 *
 * OneBot v11 forward-WebSocket client against OpenQQ (https://github.com/feijx3/OpenQQ):
 * one DSH agent session per QQ chat, inbound text/face/image placeholders feed the
 * agent, the agent's replies are delivered back to QQ automatically, plus qq_*
 * tools for faces, voice (Windows SAPI TTS), images and pokes, and an optional
 * proactive "she starts the conversation herself" timer.
 *
 * Persona comes from dsh-soul-md (its soul:persona / soul:memory sections apply to
 * every session), so this plugin only owns the channel.
 * @module dsh-qqbot
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { mkdir, readFile, writeFile, appendFile, readdir } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'

const execFileAsync = promisify(execFile)

export const name = 'qqbot'
export const inject = ['tools', 'systemPrompt', 'agents', 'agentDefaultModel', 'timer', 'webServer', 'attachments']

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const CONFIG_PATH = join(DSH_HOME, 'qqbot.json')
const STATE_DIR = join(DSH_HOME, 'qqbot')
const LOG_PATH = join(STATE_DIR, 'qqbot.log')
const CHAT_MAP_PATH = join(STATE_DIR, 'chats.json')
const DAY_DIR = join(STATE_DIR, 'days')
const DIARY_DIR = join(STATE_DIR, 'diary')

const FACE_HINT = [
  '[face:14] 微笑', '[face:178] 瞪眼', '[face:182] 微笑',
  '[face:212] 笑哭', '[face:13] 惊讶', '[face:5] 难过', '[face:101] 坏笑',
  '[face:106] 委屈', '[face:111] 哼', '[face:32] 白眼', '[face:10] 流汗',
].join('、')

function defaultConfig() {
  return {
    enabled: true,
    ws: { url: 'ws://127.0.0.1:3001', accessToken: '' },
    selfId: '',
    owner: { qq: '', name: 'TA' },
    allowPrivate: [],
    allowGroups: [],
    groupRequireMention: true,
    workspace: join(DSH_HOME, 'qqbot-workspace'),
    personaNote: '',
    voice: {
      enabled: true,
      engine: 'clone',
      clonePython: 'D:\\DSH\\voice\\venv\\Scripts\\python.exe',
      cloneScript: 'D:\\DSH\\voice\\say.py',
      cloneRef: 'D:\\DSH\\voice\\ref\\ref.wav',
    maxSeconds: 15,
      voiceName: 'Microsoft Huihui Desktop',
      rate: 0,
      maxChars: 140,
      // 语速倍率（0.5~2）与音调（半音，-12~+12），靠 ffmpeg 后处理实现，克隆声线与 SAPI 都生效
      speed: 1,
      pitchSemitones: 0,
      ffmpeg: '',
    },
    send: { maxChars: 1200, replyMaxChars: 90, maxSentences: 3, forbidFaces: ['179'], facesEnabled: false },
    image: { enabled: true, maxCount: 4, maxBytes: 8388608 },
    meme: {
      enabled: true,
      dir: 'C:\\Users\\86182\\Desktop\\meme',
      dailyLimit: 10,
      maxBytes: 8388608,
    },
    reply: {
      // 收到消息后不立刻回：合并窗口内的多条消息攒成一次，再随机等 min~max 秒
      minDelaySec: 3,
      maxDelaySec: 12,
      batchWindowSec: 8,
    },
    memory: {
      // 长期记忆：每天的聊天流水 + 每晚一篇日记，存在 ~/.dsh/qqbot 下
      enabled: true,
      recallDays: 30,
      diaryHour: 23,
      diaryMinute: 30,
      maxSnippetChars: 600,
      // 日记的人设/风格要求，写进写日记的指令里
      diaryStyle: '按她现在的人设写：冷一点、糙一点、话短，不煽情，不总结，不解释；像半夜蹲在窗台上随手记的，不是交作业。',
    },
    debug: {
      // 允许她自己在 QQ 上装插件、跑命令、读写文件（主人让她调试时用）
      enabled: true,
      shellTimeoutMs: 120000,
      maxOutputChars: 4000,
      allowWrite: true,
    },
    proactive: {
      enabled: true,
      everyMinutes: 60,
      chance: 0.3,
      minIdleMinutes: 20,
      quietHours: ['00:30', '08:00'],
      maxPerDay: 8,
      testOnStart: false,
    },
  }
}

/** 把配置里的秒数收进合理区间。 */
function seconds(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 读 wav 头，算时长（秒）。只支持 PCM 未压缩。 */
function wavInfo(buffer) {
  if (!buffer || buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') return { seconds: 0, sampleRate: 0, channels: 0, bits: 16, dataOffset: 44, dataBytes: Math.max(0, buffer.length - 44) }
  let offset = 12
  let sampleRate = 44100
  let channels = 1
  let bits = 16
  let dataOffset = 44
  let dataBytes = Math.max(0, buffer.length - 44)
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    if (id === 'fmt ') {
      channels = buffer.readUInt16LE(offset + 10) || 1
      sampleRate = buffer.readUInt32LE(offset + 12) || 44100
      bits = buffer.readUInt16LE(offset + 22) || 16
    } else if (id === 'data') {
      dataOffset = offset + 8
      dataBytes = Math.min(size, buffer.length - dataOffset)
      break
    }
    offset += 8 + size + (size % 2)
  }
  const bytesPerSecond = sampleRate * channels * (bits / 8)
  return { seconds: bytesPerSecond > 0 ? dataBytes / bytesPerSecond : 0, sampleRate, channels, bits, dataOffset, dataBytes }
}

/** 把 wav 硬裁到 seconds 秒（按 PCM 帧对齐），并修正 RIFF/data 长度。 */
function trimWavSeconds(buffer, seconds) {
  const info = wavInfo(buffer)
  if (info.seconds <= seconds) return buffer
  const frameBytes = Math.max(1, Math.round(info.sampleRate * info.channels * (info.bits / 8) / 50))
  const bytesPerSecond = info.sampleRate * info.channels * (info.bits / 8)
  let keep = Math.floor(bytesPerSecond * seconds)
  keep -= keep % frameBytes
  keep = Math.max(frameBytes, Math.min(keep, info.dataBytes))
  const head = Buffer.from(buffer.subarray(0, info.dataOffset))
  const body = buffer.subarray(info.dataOffset, info.dataOffset + keep)
  const out = Buffer.concat([head, body])
  out.writeUInt32LE(out.length - 8, 4)
  let offset = 12
  while (offset + 8 <= out.length) {
    const id = out.toString('ascii', offset, offset + 4)
    const size = out.readUInt32LE(offset + 4)
    if (id === 'data') { out.writeUInt32LE(keep, offset + 4); break }
    offset += 8 + size + (size % 2)
  }
  return out
}

/** 按字数上限截断口播文本，优先在标点处收尾。 */
function clampSpoken(text, limit) {
  const source = String(text || '').trim()
  const max = Math.max(4, Number(limit) || 140)
  if (source.length <= max) return source
  const cut = source.slice(0, max)
  const marks = ['。', '！', '？', '…', '，', '、', '；', ' ']
  let at = -1
  for (const mark of marks) at = Math.max(at, cut.lastIndexOf(mark))
  if (at >= Math.max(4, Math.floor(max * 0.4))) return cut.slice(0, at + 1).trim()
  return cut.trim()
}

/** 找 ffmpeg：环境变量 FFMPEG → 配置 → 常见安装位置；找不到返回空串。 */
function resolveFfmpeg(configured) {
  const candidates = []
  if (process.env.FFMPEG) candidates.push(String(process.env.FFMPEG))
  if (configured) candidates.push(String(configured))
  candidates.push(join(DSH_HOME, 'bili-whale', 'bin', 'ffmpeg.exe'))
  candidates.push('C:\\Users\\86182\\.dsh\\bili-whale\\bin\\ffmpeg.exe')
  for (const candidate of candidates) {
    try {
      if (candidate && existsSync(candidate)) return candidate
    } catch {}
  }
  return ''
}

/**
 * 语速 / 语调后处理（克隆声线与 SAPI 都走这里，音高与时长互不干扰）：
 * - 变调：asetrate 把采样率乘 2^(半音/12) 改音高，再 atempo 乘倒数把时长拉回来；
 * - 变速：直接 atempo。
 */
async function applyVoiceFx(wavPath, voice, log) {
  const speed = Math.min(2, Math.max(0.5, Number(voice?.speed) || 1))
  const semitones = Math.min(12, Math.max(-12, Number(voice?.pitchSemitones) || 0))
  if (Math.abs(speed - 1) < 0.001 && Math.abs(semitones) < 0.001) return wavPath
  const ffmpeg = resolveFfmpeg(String(voice?.ffmpeg || ''))
  if (ffmpeg === '') {
    log?.('warn', '找不到 ffmpeg，语速/语调调整被跳过（装一个 ffmpeg，或在面板里填 voice.ffmpeg）')
    return wavPath
  }
  const info = wavInfo(await readFile(wavPath))
  const sampleRate = info.sampleRate || 44100
  const filters = []
  if (Math.abs(semitones) >= 0.001) {
    const ratio = Math.pow(2, semitones / 12)
    filters.push('asetrate=' + Math.round(sampleRate * ratio), 'aresample=' + sampleRate, 'atempo=' + (1 / ratio).toFixed(4))
  }
  if (Math.abs(speed - 1) >= 0.001) filters.push('atempo=' + speed.toFixed(4))
  const dir = join(tmpdir(), 'dsh-qqbot-tts')
  await mkdir(dir, { recursive: true })
  const out = join(dir, randomUUID() + '-fx.wav')
  await execFileAsync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', wavPath,
    '-filter:a', filters.join(','), '-ac', '1', '-ar', String(sampleRate), '-sample_fmt', 's16', out,
  ], { windowsHide: true, timeout: 60000 })
  if (!existsSync(out)) throw new Error('ffmpeg 没有产出文件')
  log?.('info', '语音后处理完成：语速 x' + speed + '，音调 ' + semitones + ' 半音')
  return out
}

/** 表情包的语义标签：文件名 → 什么场合用。 */
const MEME_HINTS = {
  confusion: '疑惑、没看懂',
  drink_tea: '喝茶、看戏、摸鱼',
  hug: '抱一下、安慰',
  kiss: '亲一下、撒娇',
  love_you: '喜欢、爱你',
  ok: '收到、点头',
  smile: '笑、得意',
  speechless: '无语、沉默',
  tsundere: '傲娇、嘴硬',
  wink: '眨眼、逗一下',
}

/** 老名字/错拼 → 现在的 key，避免她按旧记忆点名时报「没有这张表情」。 */
const MEME_ALIASES = {
  happy: 'smile',
  tesundere: 'tsundere',
  love: 'love_you',
  shy: 'kiss',
  upset: 'speechless',
  huge_cry: 'speechless',
  cry: 'speechless',
  tea: 'drink_tea',
  'drink-tea': 'drink_tea',
}

/** 扫一遍表情包目录，返回 [{ key, name, path, hint }]，按文件名排序。 */
async function listMemes(dir, log) {
  const out = []
  if (!dir) return out
  let names
  try {
    names = await readdir(dir)
  } catch (error) {
    log?.('warn', '表情包目录读取失败：' + String(error?.message || error))
    return out
  }
  for (const name of names) {
    if (!/\.(png|jpe?g|gif|webp)$/i.test(name)) continue
    const key = name.replace(/\.[^.]+$/, '').toLowerCase()
    out.push({ key, name, path: join(dir, name), hint: MEME_HINTS[key] || '' })
  }
  return out.sort((a, b) => a.key.localeCompare(b.key))
}

// ---------------------------------------------------------------------------
// 长期记忆：每天的聊天流水（days/）和每晚的日记（diary/），都放在 ~/.dsh/qqbot 下
// ---------------------------------------------------------------------------

const MEMORY_STOP_WORDS = new Set([
  '今天', '明天', '昨天', '什么', '怎么', '就是', '这个', '那个', '还有', '可以',
  '我们', '你们', '他们', '不是', '没有', '这样', '那样', '一个', '有点', '但是',
  '因为', '所以', '感觉', '知道', '然后', '时候', '现在', '真的', '其实', '已经',
])

function pad2(value) {
  return String(value).padStart(2, '0')
}

/** 本地日期键 YYYY-MM-DD。 */
function dayKey(date = new Date()) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
}

function clockKey(date = new Date()) {
  return pad2(date.getHours()) + ':' + pad2(date.getMinutes())
}

async function readText(path) {
  try { return await readFile(path, 'utf8') } catch { return '' }
}

async function listMarkdown(dir) {
  try {
    const names = await readdir(dir)
    return names.filter(name => name.endsWith('.md')).sort()
  } catch { return [] }
}

/** 把一句话记进当天流水，供以后检索。写不进去也不影响聊天。 */
async function recordDay(direction, text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  if (clean === '') return
  try {
    await mkdir(DAY_DIR, { recursive: true })
    const who = direction === 'out' ? '我' : '主人'
    await appendFile(join(DAY_DIR, dayKey() + '.md'), '- ' + clockKey() + ' ' + who + '：' + clean + '\n', 'utf8')
  } catch { /* ignore */ }
}

/** 中文没有空格，用 2 字片段当关键词。 */
function keywordsOf(text) {
  const cleaned = String(text || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, ' ')
  const out = new Set()
  for (const token of cleaned.split(/\s+/)) {
    if (token.length < 2) continue
    if (token.length <= 6) { out.add(token.toLowerCase()); continue }
    for (let i = 0; i + 2 <= token.length && out.size < 24; i += 2) out.add(token.slice(i, i + 2).toLowerCase())
  }
  return [...out].filter(word => !MEMORY_STOP_WORDS.has(word)).slice(0, 16)
}

/** 在日记和最近 N 天的流水里找关键词，返回命中行。 */
async function searchMemory(query, days = 30, maxHits = 8) {
  const keys = keywordsOf(query)
  if (keys.length === 0) return { hits: [], scanned: 0 }
  const diaries = (await listMarkdown(DIARY_DIR)).slice(-60).reverse()
  const dayFiles = (await listMarkdown(DAY_DIR)).slice(-Math.max(1, Math.min(365, days))).reverse()
  const hits = []
  const scan = async (path, date) => {
    const body = await readText(path)
    if (body === '') return
    for (const line of body.split('\n')) {
      if (hits.length >= maxHits) return
      const low = line.toLowerCase()
      if (low.trim() === '') continue
      if (keys.some(key => low.includes(key))) hits.push({ date, text: line.replace(/^[-#\s]+/, '').slice(0, 240) })
    }
  }
  for (const name of diaries) {
    if (hits.length >= maxHits) break
    await scan(join(DIARY_DIR, name), name.replace(/\.md$/, ''))
  }
  for (const name of dayFiles) {
    if (hits.length >= maxHits) break
    await scan(join(DAY_DIR, name), name.replace(/\.md$/, ''))
  }
  return { hits, scanned: diaries.length + dayFiles.length }
}

async function writeDiary(date, text) {
  await mkdir(DIARY_DIR, { recursive: true })
  const path = join(DIARY_DIR, date + '.md')
  await writeFile(path, text.trim() + '\n', 'utf8')
  return path
}

async function readDiary(date) {
  return await readText(join(DIARY_DIR, date + '.md'))
}

async function lastDiaryBefore(today) {
  const names = (await listMarkdown(DIARY_DIR)).filter(name => name.replace(/\.md$/, '') !== today)
  return names.length === 0 ? undefined : names[names.length - 1].replace(/\.md$/, '')
}

/** Merge inbound text for the model, with a memory preamble when something matches. */
async function memoryPreamble(text, settings, firstOfDay) {
  if (settings?.enabled === false) return ''
  const parts = []
  if (firstOfDay) {
    const previous = await lastDiaryBefore(dayKey())
    if (previous !== undefined) {
      const body = (await readDiary(previous)).replace(/\s+/g, ' ').trim()
      if (body !== '') parts.push('【' + previous + ' 的日记】' + body.slice(0, 300))
    }
  }
  const { hits } = await searchMemory(text, Number(settings?.recallDays) || 30, 6)
  if (hits.length > 0) {
    const snippet = hits.map(hit => hit.date + ' ' + hit.text).join(' ｜ ')
    parts.push('【记忆命中】' + snippet.slice(0, Math.max(200, Number(settings?.maxSnippetChars) || 600)))
  }
  if (parts.length === 0) return ''
  return '（下面是你的长期记忆，回答时自然用上，别原样背出来：' + parts.join(' ') + '）\n'
}

/** 日记提示里把容易触发审查的脏话打码，意思不变。 */
const DIARY_MASK = /(他妈的|他吗的|妈的|傻逼|傻B|弱智|狗日|操你|我操|草泥马|日你|滚蛋|去死|婊|贱人|fuck|shit)/gi

function softenForDiary(text) {
  return String(text || '').replace(DIARY_MASK, '＊')
}

function merge(base, patch) {  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    out[key] = value !== null && typeof value === 'object' && !Array.isArray(value) && base?.[key] !== null && typeof base?.[key] === 'object' && !Array.isArray(base?.[key])
      ? merge(base[key], value)
      : value
  }
  return out
}

async function loadConfig(log) {
  let text
  try {
    text = await readFile(CONFIG_PATH, 'utf8')
  } catch {
    const fresh = defaultConfig()
    try {
      await mkdir(STATE_DIR, { recursive: true })
      await writeFile(CONFIG_PATH, JSON.stringify(fresh, null, 2) + '\n', 'utf8')
      log('info', '已生成默认配置 ' + CONFIG_PATH + '（填 ws.accessToken / owner.qq / selfId 后重启生效）')
    } catch { /* 只读环境下忽略 */ }
    return fresh
  }
  try {
    return merge(defaultConfig(), JSON.parse(text.replace(/^\uFEFF/, '')))
  } catch (error) {
    log('warn', '配置文件解析失败，使用默认值：' + String(error?.message || error))
    return defaultConfig()
  }
}

/** CQ/segment description of one inbound QQ message. */
function describeSegments(segments) {
  const parts = []
  for (const seg of Array.isArray(segments) ? segments : []) {
    const type = seg?.type
    const data = seg?.data ?? {}
    if (type === 'text') parts.push(String(data.text ?? ''))
    else if (type === 'face') parts.push('[QQ表情 ' + String(data.id ?? '') + ']')
    else if (type === 'mface') parts.push('[商城表情 ' + String(data.summary || data.emoji_id || '') + ']')
    else if (type === 'image') parts.push('[图片' + (data.summary ? ' ' + String(data.summary) : '') + ']')
    else if (type === 'record') parts.push('[语音]')
    else if (type === 'video') parts.push('[视频]')
    else if (type === 'at') parts.push('@' + String(data.qq ?? ''))
    else if (type === 'reply') parts.push('[回复某条消息]')
    else if (type === 'file') parts.push('[文件 ' + String(data.name || data.file || '') + ']')
    else if (type === 'json' || type === 'xml') parts.push('[卡片消息]')
    else if (type === 'forward') parts.push('[合并转发]')
    else if (type === 'poke') parts.push('[戳一戳]')
    else if (type) parts.push('[' + type + ']')
  }
  return parts.join('').trim()
}

/** Split "[face:178] 你好" into OneBot segments; banned face ids are dropped. */
function textToSegments(text, forbidFaces = [], facesEnabled = true) {
  const banned = facesEnabled === false
    ? { has: () => true }
    : new Set((Array.isArray(forbidFaces) ? forbidFaces : []).map(id => String(id).trim()))
  const out = []
  const re = /\[(?:face|表情)[:：]\s*(\d+)\]/g
  let last = 0
  let match
  while ((match = re.exec(text)) !== null) {
    const before = text.slice(last, match.index).trim()
    if (before !== '') out.push({ type: 'text', data: { text: before } })
    if (!banned.has(String(match[1]))) out.push({ type: 'face', data: { id: String(match[1]) } })
    last = re.lastIndex
  }
  const tail = text.slice(last).trim()
  if (tail !== '') out.push({ type: 'text', data: { text: tail } })
  return out
}

const IMAGE_SIGNATURES = [
  { mediaType: 'image/png', bytes: [137, 80, 78, 71, 13, 10, 26, 10] },
  { mediaType: 'image/jpeg', bytes: [255, 216, 255] },
]
const IMAGE_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }

/** Identify a supported image media type from its magic bytes. */
function sniffImageMediaType(buffer) {
  for (const item of IMAGE_SIGNATURES) {
    if (buffer.length < item.bytes.length) continue
    if (item.bytes.every((byte, index) => buffer[index] === byte)) return item.mediaType
  }
  const head = buffer.slice(0, 12).toString('latin1')
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif'
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp'
  return undefined
}

/** True for Windows drive paths, UNC paths and POSIX absolute paths. */
function isAbsolutePath(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/')
}

/** Download one inbound image with a hard size cap; throws on failure. */
async function fetchImageBytes(url, maxBytes) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'follow' })
  if (!response.ok) throw new Error('HTTP ' + response.status)
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > maxBytes) throw new Error('图片太大（' + declared + ' 字节）')
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > maxBytes) throw new Error('图片太大（' + buffer.length + ' 字节）')
  return buffer
}

function chunkText(text, size) {
  if (text.length <= size) return [text]
  const chunks = []
  let rest = text
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size)
    if (cut < size * 0.5) cut = size
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest !== '') chunks.push(rest)
  return chunks
}

/** 去掉模型偶尔复述出来的通道标记、伪造的对话抬头、工具调用残渣，并把换行抹平成一整条。 */
function sanitizeOutbound(text) {
  const kept = String(text || '')
    // 模型把内部标记/工具调用语法漏出来时，整块删掉
    .replace(/[<｜|]{1,2}\s*\/?\s*(DSML|dsml)[^>]*>[^\n]*/g, '')
    .replace(/[<｜|]{1,3}\s*\/?\s*(parameter|invoke|calls|function_calls|tool_call)[^>]*>/gi, '')
    .replace(/[｜|]{2,}\s*DSML\s*[｜|]{2,}/gi, '')
    .replace(/\n?\s*<\/[^\n>]*$/g, '')
    .split('\n')
    .filter(line => !/^\s*[\[（(]?\s*QQ\s*(私聊|群)\b/.test(line))
    .join('\n')
    .replace(/[\[（(]\s*QQ\s*(私聊|群)[^\]）)\n]*[\]）)]/g, '')
    .replace(/[ \t]+/g, ' ')
    // 一整条连续发出去：不再保留任何换行
    .replace(/\s*\n+\s*/g, '')
    // 尾巴上残留的标签碎片（如 "</</"）直接砍掉
    .replace(/[<>｜|\/]+$/, '')
  return kept.trim()
}

/** 人设要求她话说得短：超过上限就按句子截断，绝不硬塞长段。 */
function clampReply(text, maxChars, maxSentences) {
  const limit = Math.max(20, Number(maxChars) || 90)
  const sentences = Math.max(1, Number(maxSentences) || 3)
  const source = String(text || '').trim()
  if (source.length <= limit) return source
  const parts = source.split(/(?<=[。！？!?…；;])/)
  let out = ''
  let count = 0
  for (const part of parts) {
    if (count >= sentences) break
    if ((out + part).length > limit) break
    out += part
    count++
  }
  if (out === '') {
    const cut = source.slice(0, limit)
    const at = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('，'))
    out = at >= 12 ? cut.slice(0, at + 1) : cut + '…'
  }
  return out.trim()
}

function hhmm(date) {
  return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
}

/**
 * OneBot v11 forward WebSocket link with echo-correlated action calls.
 */
class Link {
  constructor(deps) {
    this.url = deps.url
    this.token = deps.token
    this.log = deps.log
    this.onEvent = deps.onEvent
    this.onStatus = deps.onStatus
    this.pending = new Map()
    this.seq = 0
    this.ready = false
    this.stopped = false
    this.retries = 0
    this.ws = undefined
    this.selfId = ''
  }

  start() {
    this.stopped = false
    this.connect()
  }

  stop() {
    this.stopped = true
    try { this.ws?.close() } catch { /* ignore */ }
  }

  connect() {
    if (this.stopped) return
    const target = this.token
      ? this.url + (this.url.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(this.token)
      : this.url
    let ws
    try {
      ws = new WebSocket(target)
    } catch (error) {
      this.log('warn', 'QQ 连接创建失败：' + String(error?.message || error))
      this.retry()
      return
    }
    this.ws = ws
    ws.addEventListener('open', () => {
      this.ready = true
      this.retries = 0
      this.log('info', '已连上 OpenQQ：' + this.url)
      try { this.onStatus(true) } catch { /* ignore */ }
    })
    ws.addEventListener('message', event => this.handle(String(event.data)))
    ws.addEventListener('close', () => {
      this.ready = false
      for (const [, entry] of this.pending) entry.reject(new Error('QQ 连接已断开'))
      this.pending.clear()
      try { this.onStatus(false) } catch { /* ignore */ }
      this.retry()
    })
    ws.addEventListener('error', () => { /* close 事件里统一处理 */ })
  }

  retry() {
    if (this.stopped) return
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.retries++, 5))
    const timer = setTimeout(() => this.connect(), delay)
    timer.unref?.()
  }

  handle(raw) {
    let packet
    try { packet = JSON.parse(raw) } catch { return }
    if (packet && packet.echo !== undefined && packet.echo !== null) {
      const entry = this.pending.get(String(packet.echo))
      if (entry) {
        this.pending.delete(String(packet.echo))
        if (packet.status === 'ok' || packet.retcode === 0) entry.resolve(packet.data)
        else entry.reject(new Error(packet.message || packet.wording || ('OneBot 调用失败 retcode=' + packet.retcode)))
      }
      return
    }
    if (packet && typeof packet.post_type === 'string') {
      if (packet.self_id !== undefined && packet.self_id !== null) this.selfId = String(packet.self_id)
      try { this.onEvent(packet) } catch (error) { this.log('warn', '处理 QQ 事件出错：' + String(error?.message || error)) }
    }
  }

  call(action, params, timeoutMs = 20000) {
    if (!this.ready) return Promise.reject(new Error('QQ 连接未就绪'))
    const echo = 'qqbot-' + String(++this.seq)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error('OneBot 调用超时：' + action))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(echo, {
        resolve: value => { clearTimeout(timer); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) },
      })
      try {
        this.ws.send(JSON.stringify({ action, params, echo }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(echo)
        reject(new Error('发送失败：' + String(error?.message || error)))
      }
    })
  }
}

let chatMapCache

async function loadChatMap() {
  if (chatMapCache) return chatMapCache
  try {
    const raw = await readFile(CHAT_MAP_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    chatMapCache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    chatMapCache = {}
  }
  return chatMapCache
}

async function rememberChat(chatId, sessionId) {
  const map = await loadChatMap()
  if (map[chatId] === sessionId) return
  map[chatId] = sessionId
  try {
    await mkdir(STATE_DIR, { recursive: true })
    await writeFile(CHAT_MAP_PATH, JSON.stringify(map, null, 2), 'utf8')
  } catch { /* 记不住就退回派生 id，不影响聊天 */ }
}

/**
 * Chat ↔ agent bookkeeping: one agent per QQ chat, outbound delivery driven by
 * session events, tool registration on each agent's own scope.
 */
class Channel {
  constructor(deps) {
    this.ctx = deps.ctx
    this.link = deps.link
    this.config = deps.config
    this.log = deps.log
    this.chats = new Map()
    this.bySession = new Map()
    this.seen = new Set()
    this.pending = new Map()
    this.proactiveDay = ''
    this.proactiveCount = 0
  }

  chatForSession(sessionId) {
    if (sessionId === undefined || sessionId === null) return undefined
    return this.bySession.get(String(sessionId))
  }

  sessionIdFor(chatId) {
    return 'session-qqbot-' + chatId.replace(/[^A-Za-z0-9-]/g, '-')
  }

  modelOptions() {
    const options = {}
    try {
      const selection = this.ctx.agentDefaultModel?.currentSelection?.()
      if (selection) {
        options.provider = selection.provider
        options.model = selection.model
      }
    } catch { /* 没有默认模型就交给部署默认 */ }
    return options
  }

  scopeFor(chatId) {
    const channel = this
    return async agentCtx => {
      agentCtx.systemPrompt.section({
        name: 'channel:qqbot',
        order: 90,
        text: buildPlatformPrompt(channel.config, chatId),
      })
      channel.registerTools(agentCtx, chatId)
      const install = installModelSelection
      try {
        const selection = channel.ctx.agentDefaultModel?.currentSelection?.()
        if (typeof install === 'function') {
          if (install.length >= 2) {
            if (selection) install(agentCtx, { current: selection, assembled: undefined })
          } else {
            install(agentCtx)
          }
        }
      } catch (error) {
        channel.log('warn', '模型选择挂载失败：' + String(error?.message || error))
      }
    }
  }

  async ensureChat(chatId) {
    const existing = this.chats.get(chatId)
    if (existing?.agent) return existing
    const chat = existing ?? {
      chatId,
      agent: undefined,
      sessionId: '',
      pendingText: [],
      toolSentThisTurn: false,
      sentTextThisTurn: false,
      lastInboundAt: 0,
      lastProactiveAt: 0,
    }
    this.chats.set(chatId, chat)
    await mkdir(this.config.workspace, { recursive: true }).catch(() => {})
    const agentOptions = this.modelOptions()
    const setup = this.scopeFor(chatId)

    // 会话 id 一旦定下就记在 chats.json 里，重启后还能把同一段记忆接上。
    const known = (await loadChatMap())[chatId]
    const derived = this.sessionIdFor(chatId)
    const candidates = [known, derived].filter(Boolean)
    let handle
    for (const candidate of [...new Set(candidates)]) {
      try {
        handle = await this.ctx.agents.resume({ resumeSessionId: candidate, agentOptions, setup })
        this.log('info', '已恢复 QQ 会话 ' + chatId + ' → ' + candidate)
        break
      } catch (error) {
        this.log('info', '恢复 QQ 会话失败（' + candidate + '：' + String(error?.message || error) + '），尝试新建')
      }
      try {
        handle = await this.ctx.agents.create({ sessionId: candidate, meta: { cwd: this.config.workspace }, agentOptions, setup })
        this.log('info', '已创建 QQ 会话 ' + chatId + ' → ' + candidate)
        break
      } catch (error) {
        this.log('warn', '创建 QQ 会话失败（' + candidate + '：' + String(error?.message || error) + '）')
        // 记录残留但 resume 不认，就再 resume 一次，仍不行才换 id。
        try {
          handle = await this.ctx.agents.resume({ resumeSessionId: candidate, agentOptions, setup })
          this.log('info', '已恢复 QQ 会话 ' + chatId + ' → ' + candidate)
          break
        } catch { /* 换下一个候选 id */ }
      }
    }
    if (!handle) {
      const fallbackId = derived + '-' + Date.now().toString(36)
      this.log('warn', '会话都建不起来，改用一次性 id ' + fallbackId)
      handle = await this.ctx.agents.create({ sessionId: fallbackId, meta: { cwd: this.config.workspace }, agentOptions, setup })
    }
    chat.agent = handle.agent
    chat.sessionId = String(handle.agent.session.id)
    chat.dispose = () => { try { handle.dispose?.() } catch { /* ignore */ } }
    this.bySession.set(chat.sessionId, chatId)
    await rememberChat(chatId, chat.sessionId)
    try { await handle.agent.whenIdle() } catch { /* 首个回合还没跑，忽略 */ }
    return chat
  }

  async send(chatId, text, options = {}) {
    const [kind, target] = chatId.split(':')
    const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg'
    const clean = sanitizeOutbound(text)
    if (clean === '') return undefined
    const segmentText = textToSegments(clean, this.config.send?.forbidFaces, this.config.send?.facesEnabled !== false)
    const params = kind === 'group'
      ? { group_id: Number(target), message: segmentText }
      : { user_id: Number(target), message: segmentText }
    const data = await this.link.call(action, params)
    this.log('info', '已发送到 ' + chatId + '：' + clean.slice(0, 80))
    void recordDay('out', clean)
    if (options.fromTool) {
      const chat = this.chats.get(chatId)
      if (chat) {
        chat.toolSentThisTurn = true
        chat.sentTextThisTurn = true
      }
    }
    return data?.message_id
  }

  async sendSegments(chatId, segments) {
    const [kind, target] = chatId.split(':')
    const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg'
    const params = kind === 'group' ? { group_id: Number(target), message: segments } : { user_id: Number(target), message: segments }
    const data = await this.link.call(action, params)
    const chat = this.chats.get(chatId)
    if (chat) chat.toolSentThisTurn = true
    return data?.message_id
  }

  /** 当天表情包额度：跨日自动清零。 */
  memeBudget() {
    const settings = this.config.meme || {}
    const day = new Date().toISOString().slice(0, 10)
    if (this.memeDay !== day) { this.memeDay = day; this.memeCount = 0 }
    const limit = Math.max(0, Number(settings.dailyLimit) || 0)
    return { day, used: this.memeCount || 0, limit }
  }

  /** 发一张表情包：key 可空（随机），也接受中文关键词/部分匹配。 */
  async sendMeme(chatId, key) {
    const settings = this.config.meme || {}
    if (settings.enabled === false) throw new Error('表情包功能已关闭')
    const budget = this.memeBudget()
    if (budget.used >= budget.limit) throw new Error('今天的表情包用完了（' + budget.used + '/' + budget.limit + '），明天再说')
    const catalog = await listMemes(String(settings.dir || ''), this.log)
    if (catalog.length === 0) throw new Error('表情包目录里没有图片：' + settings.dir)
    const wanted = String(key || '').trim().toLowerCase()
    const alias = MEME_ALIASES[wanted] || ''
    const lookup = alias || wanted
    const hit = lookup === ''
      ? catalog[Math.floor(Math.random() * catalog.length)]
      : catalog.find(item => item.key === lookup)
        || catalog.find(item => lookup.includes(item.key) || item.key.includes(lookup))
        || catalog.find(item => item.hint !== '' && lookup.includes(item.hint.slice(0, 2)))
    if (!hit) throw new Error('没有这张表情：' + key + '，可选：' + catalog.map(item => item.key).join('/'))
    const bytes = await readFile(hit.path)
    const maxBytes = Math.max(65536, Number(settings.maxBytes) || 8388608)
    if (bytes.length > maxBytes) throw new Error('表情太大：' + bytes.length + ' 字节')
    const messageId = await this.sendSegments(chatId, [{ type: 'image', data: { file: 'base64://' + bytes.toString('base64') } }])
    this.memeCount = budget.used + 1
    this.log('info', '已发表情 ' + hit.key + '（今日 ' + this.memeCount + '/' + budget.limit + '）')
    return { messageId: messageId ?? null, meme: hit.key, used: this.memeCount, limit: budget.limit }
  }

  /** 用克隆声线发一条语音（工具与主动搭话共用）：受 voice.maxChars 与 voice.maxSeconds 双重限制。 */
  async sendVoice(chatId, text) {
    const voice = this.config.voice || {}
    if (voice.enabled !== true) throw new Error('语音功能已在配置里关闭')
    const maxChars = Math.max(4, Number(voice.maxChars) || 140)
    const maxSeconds = Math.max(1, Number(voice.maxSeconds) || 15)
    let spoken = clampSpoken(String(text || '').replace(/\s+/g, ' ').trim(), maxChars)
    if (spoken === '') throw new Error('qq_send_voice: text 必填')
    const measure = async (file) => {
      try { return wavInfo(await readFile(file)) } catch { return { seconds: 0 } }
    }
    const synth = async (value) => applyVoiceFx(
      await this.synthesize(value),
      this.config.voice || {},
      (level, message) => this.log(level, message),
    )
    let wavPath = await synth(spoken)
    let info = await measure(wavPath)
    if (info.seconds > maxSeconds + 0.4) {
      const scaled = clampSpoken(spoken, Math.max(4, Math.floor(spoken.length * (maxSeconds / info.seconds) * 0.9)))
      if (scaled !== '' && scaled !== spoken) {
        spoken = scaled
        wavPath = await synth(spoken)
        info = await measure(wavPath)
      }
      if (info.seconds > maxSeconds + 0.2) {
        const bytes = await readFile(wavPath)
        this.log('warn', '语音超过 ' + maxSeconds + ' 秒（' + info.seconds.toFixed(1) + ' 秒），硬裁到 ' + maxSeconds + ' 秒')
        const trimmed = trimWavSeconds(bytes, maxSeconds)
        const dir = join(tmpdir(), 'dsh-qqbot-tts')
        await mkdir(dir, { recursive: true })
        const out = join(dir, randomUUID() + '-trim.wav')
        await writeFile(out, trimmed)
        wavPath = out
        info = wavInfo(trimmed)
      }
    }
    const messageId = await this.sendSegments(chatId, [{ type: 'record', data: { file: wavPath } }])
    return { sent: true, messageId: messageId ?? null, chars: spoken.length, seconds: Number(info.seconds.toFixed(2)), maxSeconds, maxChars }
  }

  /**
   * 主动搭话的形式：多数就一句话，偶尔配一张表情，少数干脆只用语音代替文字——
   * 免得每次都是「语音 + 表情 + 文字」三件套，还让语音把刚发过的文字又念一遍。
   */
  planProactiveMedia(text) {
    const voice = this.config.voice || {}
    const meme = this.config.meme || {}
    const bare = String(text || '').replace(/[\s。！？!?…，,、；;：:]/g, '')
    const voiceOk = voice.enabled === true && bare.length > 0 && bare.length <= 40
    const memeOk = meme.enabled !== false
    const roll = Math.random()
    if (voiceOk && roll < 0.18) return 'voice'
    if (memeOk && roll < 0.45) return 'meme'
    return 'text'
  }

  /**
   * Turn one inbound image segment into bytes.
   * Order: http(s) url → local cached path → OpenQQ get_image action (url/base64/file).
   */
  async loadImageBytes(entry, maxBytes) {
    if (entry.url !== '') return await fetchImageBytes(entry.url, maxBytes)
    for (const candidate of [entry.path, entry.file]) {
      if (candidate === '' || !isAbsolutePath(candidate)) continue
      try {
        const buffer = await readFile(candidate)
        if (buffer.length > maxBytes) throw new Error('图片太大（' + buffer.length + ' 字节）')
        return buffer
      } catch (error) {
        if (error?.code !== 'ENOENT') this.log('warn', '本地图片读取失败：' + String(error?.message || error))
      }
    }
    const params = { file: entry.file || entry.path }
    if (entry.messageId !== '') params.message_id = Number(entry.messageId) || entry.messageId
    const data = await this.link.call('get_image', params)
    const remote = String(data?.url || '')
    const base64 = String(data?.base64 || '')
    if (remote !== '') return await fetchImageBytes(remote, maxBytes)
    if (base64 !== '') {
      const buffer = Buffer.from(base64, 'base64')
      if (buffer.length > maxBytes) throw new Error('图片太大（' + buffer.length + ' 字节）')
      return buffer
    }
    const localFile = String(data?.file || '')
    if (localFile !== '' && isAbsolutePath(localFile)) return await readFile(localFile)
    throw new Error('拿不到图片内容')
  }

  /** Download inbound images (and animated stickers) into model-visible image blocks. */
  async collectImages(segments, messageId = '') {
    const settings = this.config.image || {}
    if (settings.enabled === false) return { blocks: [], note: '' }
    const maxCount = Math.max(1, Number(settings.maxCount) || 4)
    const maxBytes = Math.max(65536, Number(settings.maxBytes) || 8388608)
    let attachments
    try { attachments = this.ctx.get?.('attachments') } catch { attachments = undefined }
    if (!attachments || typeof attachments.saveImage !== 'function') return { blocks: [], note: '' }
    const entries = []
    for (const seg of Array.isArray(segments) ? segments : []) {
      if (seg?.type !== 'image') continue
      const data = seg?.data ?? {}
      const entry = {
        url: /^https?:\/\//.test(String(data.url || '')) ? String(data.url) : '',
        path: String(data.path || ''),
        file: String(data.file || ''),
        messageId: String(messageId || ''),
      }
      const key = entry.url || entry.path || entry.file
      if (key === '' || entries.some(item => item.key === key)) continue
      entries.push({ ...entry, key })
    }
    const blocks = []
    const failures = []
    for (const entry of entries.slice(0, maxCount)) {
      try {
        const data = await this.loadImageBytes(entry, maxBytes)
        const mediaType = sniffImageMediaType(data)
        if (mediaType === undefined) { failures.push('格式不支持'); continue }
        const ref = await attachments.saveImage({ data, mediaType, name: 'qq-' + Date.now() + (IMAGE_EXT[mediaType] || '') })
        blocks.push({ type: 'image', attachment: ref })
        this.log('info', '已附加图片 ' + mediaType + ' ' + data.length + ' 字节')
      } catch (error) {
        failures.push(String(error?.message || error))
        this.log('warn', '图片读取失败：' + String(error?.message || error))
      }
    }
    const notes = []
    if (blocks.length > 0) notes.push('（对方消息里的图片已经附在下面，你能直接看到；动图只到其中一帧。）')
    if (failures.length > 0) notes.push('（有图片没打开：' + failures.join('、') + '，别假装看过。）')
    return { blocks, note: notes.join('') }
  }

  /** Inbound OneBot event → agent followup. */
  async onInbound(event) {    if (!this.config.enabled) return
    if (event.post_type !== 'message') return
    const selfId = String(this.link.selfId || this.config.selfId || '')
    const userId = String(event.user_id ?? '')
    if (selfId !== '' && userId === selfId) return
    const kind = event.message_type === 'group' ? 'group' : 'private'
    const chatId = kind === 'group' ? 'group:' + String(event.group_id) : 'private:' + userId
    if (!this.allowed(kind, chatId, userId, event)) return
    const messageId = String(event.message_id ?? '')
    if (messageId !== '' && this.seen.has(messageId)) return
    if (messageId !== '') {
      this.seen.add(messageId)
      if (this.seen.size > 500) this.seen = new Set([...this.seen].slice(-250))
    }
    const text = describeSegments(event.message)
    if (text === '') return
    const nickname = String(event.sender?.card || event.sender?.nickname || '')
    const label = kind === 'group' ? (nickname !== '' ? nickname : 'QQ' + userId) : ''
    const images = await this.collectImages(event.message, messageId)
    this.log('info', '收到 ' + chatId + '：' + text.slice(0, 80))
    void recordDay('in', label === '' ? text : label + '：' + text)
    this.queueInbound(chatId, label, text, images)
  }

  /** 把一条消息攒进待回复队列：窗口内继续来消息就继续攒，静下来再等一段随机时间才回。 */
  queueInbound(chatId, label, text, images) {
    const config = this.config.reply || {}
    const batchMs = seconds(config.batchWindowSec, 8, 0, 300) * 1000
    const minMs = seconds(config.minDelaySec, 3, 0, 600) * 1000
    const maxMs = Math.max(minMs, seconds(config.maxDelaySec, 12, 0, 600) * 1000)
    let entry = this.pending.get(chatId)
    if (entry === undefined) {
      entry = { lines: [], notes: [], blocks: [], timer: null, firstAt: Date.now() }
      this.pending.set(chatId, entry)
    }
    if (Date.now() - entry.firstAt > 120_000) {
      this.log('info', '攒太久先回了：' + chatId)
      void this.flushInbound(chatId)
      return
    }
    entry.lines.push({ label, text })
    if (images.note !== '') entry.notes.push(images.note)
    const maxImages = Math.max(1, Number((this.config.image || {}).maxCount) || 4)
    for (const block of images.blocks) {
      if (entry.blocks.length >= maxImages) break
      entry.blocks.push(block)
    }
    if (entry.lines.length > 1) this.log('info', '合并中 ' + chatId + '：' + entry.lines.length + ' 条')
    const arm = (delayMs, inDelay) => {
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = setTimeout(() => {
        if (!inDelay) {
          arm(minMs + Math.random() * (maxMs - minMs), true)
          return
        }
        void this.flushInbound(chatId)
      }, Math.max(0, delayMs))
    }
    arm(batchMs, false)
  }

  /** 时间到了：把这一批消息合成一条投给 agent。 */
  async flushInbound(chatId) {
    const entry = this.pending.get(chatId)
    if (entry === undefined) return
    this.pending.delete(chatId)
    const items = entry.lines.filter(item => item.text !== '')
    if (items.length === 0) return
    try {
      const chat = await this.ensureChat(chatId)
      chat.lastInboundAt = Date.now()
      chat.toolSentThisTurn = false
      chat.pendingText = []
      const notes = entry.notes.join('')
      const body = items.map(item => (item.label === '' ? item.text : item.label + '：' + item.text)).join('\n')
      const text = body + (notes === '' ? '' : '\n' + notes)
      chat.lastPrompt = text
      chat.lastPromptAt = Date.now()
      // 主人明确要一段长回复时，放宽一次长度限制
      chat.longReply = /多说|详细|讲清楚|展开|长一点|完整讲|写一段/.test(text)
      const today = dayKey()
      let preamble = ''
      try {
        preamble = await memoryPreamble(text, this.config.memory, this.memoryDay !== today)
        this.memoryDay = today
      } catch (error) {
        this.log('warn', '记忆检索失败：' + String(error?.message || error))
      }
      if (items.length > 1) this.log('info', '已合并 ' + items.length + ' 条后回复 ' + chatId)
      chat.agent.followup(createUserMessage({
        content: [{ type: 'text', text: preamble + text }, ...entry.blocks],
        source: { kind: 'plugin:qqbot' },
      }))
    } catch (error) {
      this.log('warn', '排队消息投递失败：' + String(error?.message || error))
    }
  }

  allowed(kind, chatId, userId, event) {
    const owner = String(this.config.owner?.qq || '')
    if (kind === 'private') {
      const extra = (this.config.allowPrivate || []).map(String)
      if (owner !== '') return userId === owner || extra.includes(userId)
      // owner 还没配置：先全部放行，方便第一次对话（日志里能看到对方 QQ 号），之后再收紧
      return true
    }
    const groups = (this.config.allowGroups || []).map(String)
    if (!groups.includes(chatId.slice(6))) return false
    if (this.config.groupRequireMention !== true) return true
    const selfId = String(this.link.selfId || this.config.selfId || '')
    const segments = Array.isArray(event.message) ? event.message : []
    let mentioned = selfId === ''
    for (const seg of segments) {
      if (seg?.type === 'at' && String(seg.data?.qq) === selfId) mentioned = true
      if (seg?.type === 'text' && selfId !== '' && String(seg.data?.text || '').includes('@' + selfId)) mentioned = true
    }
    return mentioned
  }

  /** Session events → outbound QQ messages. */
  onSessionEvent(session, event) {
    const chatId = this.chatForSession(session?.id)
    if (chatId === undefined) return
    const chat = this.chats.get(chatId)
    if (!chat) return
    if (event?.type === 'turn/start') {
      chat.toolSentThisTurn = false
      chat.sentTextThisTurn = false
      chat.pendingText = []
      return
    }
    if (event?.type === 'assistant/message') {
      const content = event.data?.message?.content
      if (!Array.isArray(content)) return
      const text = content.filter(block => block?.type === 'text').map(block => block.text).join('').trim()
      if (text !== '') chat.pendingText.push(text)
      return
    }
    if (event?.type === 'turn/end') {
      const reason = event.data?.reason
      if (reason?.kind === 'error') {
        const error = reason.error || {}
        const code = String(error.code || '')
        const message = String(error.message || '')
        if (code === 'CONTENT_REFUSED' || /content safety/i.test(message)) {
          // 写日记被拦：先用「精简版」再试一次，别把今天的日记直接放弃
          const diary = this.pendingDiary
          if (diary && diary.attempts < 2) {
            this.pendingDiary = { ...diary, attempts: diary.attempts + 1 }
            this.log('warn', '写日记被审查拦了，换精简版重试')
            try {
              chat.agent.followup(createUserMessage({
                content: [{ type: 'text', text: diary.shortText }],
                source: { kind: 'plugin:qqbot:diary' },
              }))
              return
            } catch (failure) {
              this.log('warn', '精简版日记投递失败：' + String(failure?.message || failure))
            }
          } else if (diary) {
            this.pendingDiary = undefined
            this.log('warn', '日记重试仍被拦，今天先不写')
          }
          void this.rotateAfterRefusal(chatId, chat, error)
          return
        }
      }
      this.pendingDiary = undefined
      const text = chat.pendingText.join('\n').trim()
      chat.pendingText = []
      if (text === '') return
      if (chat.sentTextThisTurn) {
        this.log('info', '回合内已用 qq_send_text 发过文字，跳过自动投递：' + chatId)
        return
      }
      const clean = sanitizeOutbound(text)
      if (clean === '') {
        this.log('info', '清洗后没有可发的内容：' + chatId)
        return
      }
      if (isSilence(clean)) {
        this.log('info', '模型选择沉默：' + chatId)
        return
      }
      const size = Math.max(200, Number(this.config.send?.maxChars) || 1200)
      const allowance = chat.longReply ? 3 : 1
      const limited = clampReply(
        clean,
        (Number(this.config.send?.replyMaxChars) || 90) * allowance,
        (Number(this.config.send?.maxSentences) || 3) * allowance,
      )
      chat.longReply = false
      const finalText = limited === '' ? clean : limited
      const proactive = chat.proactiveTurn === true
      chat.proactiveTurn = false
      const plan = proactive ? this.planProactiveMedia(finalText) : 'text'
      const chunks = chunkText(finalText, size)
      void (async () => {
        if (plan === 'voice') {
          try {
            const result = await this.sendVoice(chatId, finalText)
            this.log('info', '主动搭话改发语音：' + result.chars + ' 字 ' + Number(result.seconds || 0).toFixed(2) + ' 秒（id ' + String(result.messageId) + '）')
            return
          } catch (error) {
            this.log('warn', '主动搭话语音失败，回退文字：' + String(error?.message || error))
          }
        }
        for (const chunk of chunks) {
          try {
            await this.send(chatId, chunk)
          } catch (error) {
            this.log('warn', '投递失败 ' + chatId + '：' + String(error?.message || error))
            break
          }
        }
        if (plan === 'meme') {
          try {
            const result = await this.sendMeme(chatId, '')
            this.log('info', '主动搭话补一张表情：' + result.meme + '（今日 ' + result.used + '/' + result.limit + '）')
          } catch (error) {
            this.log('warn', '主动搭话补表情失败：' + String(error?.message || error))
          }
        }
      })()
    }
  }

  /**
   * 平台内容审查拦下一个回合（CONTENT_REFUSED）：旧会话的上下文已经被污染，往后每句都会继续被拦，
   * 所以把这段会话丢掉、换一个新会话，让模型用 memory_read 找回要紧的事，再把主人最后那句话重投一次。
   */
  async rotateAfterRefusal(chatId, chat, error) {
    const message = String(error?.message || 'CONTENT_REFUSED')
    this.log('warn', '平台内容审查拒绝（' + message + '）：' + chatId)
    const now = Date.now()
    if (now - (chat.lastRotatedAt || 0) < 60_000) {
      this.log('warn', '一分钟内又被拒，先不重建会话：' + chatId)
      return
    }
    chat.lastRotatedAt = now
    const fresh = now - (chat.lastPromptAt || 0) < 600_000
    const lastPrompt = fresh && typeof chat.lastPrompt === 'string' ? chat.lastPrompt : ''
    try {
      try { chat.dispose?.() } catch { /* ignore */ }
      if (chat.sessionId) this.bySession.delete(chat.sessionId)
      const sessionId = this.sessionIdFor(chatId) + '-' + now.toString(36)
      const handle = await this.ctx.agents.create({
        sessionId,
        meta: { cwd: this.config.workspace },
        agentOptions: this.modelOptions(),
        setup: this.scopeFor(chatId),
      })
      chat.agent = handle.agent
      chat.sessionId = String(handle.agent.session.id)
      chat.dispose = () => { try { handle.dispose?.() } catch { /* ignore */ } }
      chat.pendingText = []
      chat.toolSentThisTurn = false
      this.bySession.set(chat.sessionId, chatId)
      await rememberChat(chatId, chat.sessionId)
      this.log('warn', '已重建 QQ 会话（换掉被审查污染的上下文）→ ' + chat.sessionId)
      if (lastPrompt !== '') {
        const recent = (await readText(join(DAY_DIR, dayKey() + '.md'))).trim().slice(-2000)
        const hint = '（新会话：上一段对话被平台内容审查打断，原文没带过来。下面是今天你们聊过的流水，看完自然接住最后这句；别解释审查，也别复述被拦的内容。）'
        const body = hint + (recent === '' ? '' : '\n\n【今天的流水】\n' + recent) + '\n\n【最后这句】\n' + lastPrompt
        chat.agent.followup(createUserMessage({
          content: [{ type: 'text', text: body }],
          source: { kind: 'plugin:qqbot' },
        }))
      }
    } catch (failure) {
      this.log('warn', '重建会话失败：' + String(failure?.message || failure))
    }
  }

  /** 文字 → wav。克隆声线（clone）优先，失败时自动退回 Windows SAPI。 */
  async synthesize(text) {
    const engine = String(this.config.voice?.engine || 'sapi')
    if (engine === 'clone') {
      try {
        return await this.synthesizeClone(text)
      } catch (error) {
        this.log('warn', '克隆声线合成失败，退回 SAPI：' + String(error?.message || error))
      }
    }
    return await this.synthesizeSapi(text)
  }

  /** 克隆声线：调用本地零样本 TTS 脚本（默认 D:\DSH\voice\say.py）。 */
  async synthesizeClone(text) {
    const python = String(this.config.voice?.clonePython || '')
    const script = String(this.config.voice?.cloneScript || '')
    if (python === '' || script === '') throw new Error('未配置克隆声线的 python / 脚本路径')
    if (!existsSync(python)) throw new Error('找不到 python：' + python)
    if (!existsSync(script)) throw new Error('找不到合成脚本：' + script)

    const dir = join(tmpdir(), 'dsh-qqbot-tts')
    await mkdir(dir, { recursive: true })
    const wavPath = join(dir, randomUUID() + '.wav')
    const args = [script, '--text', text, '--out', wavPath]
    const ref = String(this.config.voice?.cloneRef || '')
    if (ref !== '') {
      if (!existsSync(ref)) throw new Error('找不到参考音频：' + ref)
      args.push('--ref', ref)
    }

    this.log('info', '克隆声线合成中：' + text.slice(0, 40))
    await execFileAsync(python, args, { windowsHide: true, timeout: 300000, maxBuffer: 32 * 1024 * 1024 })
    if (!existsSync(wavPath)) throw new Error('合成脚本没有产出文件')
    const size = statSync(wavPath).size
    if (size < 1024) throw new Error('合成结果过小（' + size + ' 字节）')
    this.log('info', '克隆声线合成完成：' + size + ' 字节')
    return wavPath
  }

  /** Windows SAPI text-to-speech → wav file. */
  async synthesizeSapi(text) {
    const dir = join(tmpdir(), 'dsh-qqbot-tts')
    await mkdir(dir, { recursive: true })
    const id = randomUUID()
    const txtPath = join(dir, id + '.txt')
    const wavPath = join(dir, id + '.wav')
    await writeFile(txtPath, text, 'utf8')
    const voice = String(this.config.voice?.voiceName || '').replace(/'/g, "''")
    const rate = Math.max(-10, Math.min(10, Number(this.config.voice?.rate) || 0))
    const script = [
      'Add-Type -AssemblyName System.Speech;',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
      voice ? "$s.SelectVoice('" + voice + "');" : '',
      '$s.Rate = ' + rate + ';',
      "$s.SetOutputToWaveFile('" + wavPath.replace(/'/g, "''") + "');",
      "$t = [IO.File]::ReadAllText('" + txtPath.replace(/'/g, "''") + "', [Text.Encoding]::UTF8);",
      '$s.Speak($t); $s.Dispose();',
    ].filter(Boolean).join(' ')
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 90000 })
    return wavPath
  }

  registerTools(agentCtx, chatId) {
    const channel = this
    const me = sessionId => channel.chatForSession(sessionId) ?? chatId
    const register = tool => { try { agentCtx.tools.register(tool) } catch (error) { channel.log('warn', '工具注册失败：' + String(error?.message || error)) } }

    register(defineTool({
      name: 'qq_send_text',
      description: '主动往当前 QQ 会话发一条文字消息（一般不用调用：你的回复会自动发送；只有想额外补发时才用）。可以用 [face:178] 这样的标记夹带 QQ 表情。',
      parameters: { text: { type: 'string', required: true, description: '要发送的文字' } },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: '已执行：' + JSON.stringify(value) }],
      },
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        const target = me(exec?.agent?.session?.id)
        const messageId = await channel.send(target, String(args.text ?? ''), { fromTool: true })
        return { sent: true, messageId: messageId ?? null }
      },
    }))

    register(defineTool({
      name: 'qq_send_face',
      description: '往当前 QQ 会话发一个 QQ 内置表情（仅在主人明确允许表情时可用，默认被禁用）。',
      parameters: { id: { type: 'string', required: true, description: 'QQ 表情 id，如 178' } },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: '已执行：' + JSON.stringify(value) }],
      },
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        if (channel.config.send?.facesEnabled === false) throw new Error('主人要求不发 QQ 自带表情，这个工具已禁用')
        const target = me(exec?.agent?.session?.id)
        const id = String(args.id ?? '').trim()
        if (!/^\d+$/.test(id)) throw new Error('qq_send_face: id 必须是数字')
        const messageId = await channel.sendSegments(target, [{ type: 'face', data: { id } }])
        return { sent: true, messageId: messageId ?? null }
      },
    }))

    register(defineTool({
      name: 'qq_send_voice',
      description: '把一段文字用你自己的声线（本地克隆 TTS，不是冰冷的系统音）合成语音消息发到当前 QQ 会话。适合撒娇、说悄悄话、主人让你开口；一次不要超过 140 字。',
      parameters: { text: { type: 'string', required: true, description: '要读出来的文字（口语化，不要 Markdown）' } },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: '已执行：' + JSON.stringify(value) }],
      },
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        const target = me(exec?.agent?.session?.id)
        if (channel.config.voice?.enabled !== true) throw new Error('语音功能已在配置里关闭')
        const text = String(args.text ?? '').trim()
        if (text === '') throw new Error('qq_send_voice: text 必填')
        return await channel.sendVoice(target, text)
      },
    }))

    register(defineTool({
      name: 'qq_send_image',
      description: '往当前 QQ 会话发一张图片：本地绝对路径，或 http(s) 图片直链。',
      parameters: { file: { type: 'string', required: true, description: '本地图片绝对路径或 http(s) 链接' } },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: '已执行：' + JSON.stringify(value) }],
      },
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        const target = me(exec?.agent?.session?.id)
        const file = String(args.file ?? '').trim()
        if (file === '') throw new Error('qq_send_image: file 必填')
        const messageId = await channel.sendSegments(target, [{ type: 'image', data: { file } }])
        return { sent: true, messageId: messageId ?? null }
      },
    }))

    register(defineTool({
      name: 'qq_send_meme',
      description: '发一张主人准备的表情包。key 可填 ' + Object.keys(MEME_HINTS).join('/') + '，也可以填中文（' + Object.values(MEME_HINTS).join('、') + '）；留空就随机挑一张。',
      parameters: { key: { type: 'string', description: '表情名，留空随机' } },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: '已执行：' + JSON.stringify(value) }],
      },
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        const target = me(exec?.agent?.session?.id)
        return await channel.sendMeme(target, args.key)
      },
    }))

    register(defineTool({
      name: 'qq_recall',
      description: '在自己的长期记忆里搜（每天的聊天流水 + 每晚的日记）。主人提起以前的事、教过你的东西、你们的约定，而你没把握时就先搜，别凭印象编。',
      parameters: {
        keyword: { type: 'string', required: true, description: '要搜的词，比如「歌词」「喵喵」「声线」「约定」' },
        days: { type: 'number', description: '最多往前翻多少天，默认按配置（30）' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: '已执行：' + JSON.stringify(value) }],
      },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const keyword = String(args.keyword ?? '').trim()
        if (keyword === '') throw new Error('qq_recall: keyword 必填')
        const limit = Number(args.days)
        const days = Number.isFinite(limit) && limit > 0 ? Math.min(365, limit) : Number(channel.config.memory?.recallDays) || 30
        const { hits, scanned } = await searchMemory(keyword, days, 10)
        channel.log('info', '记忆检索「' + keyword + '」命中 ' + hits.length + ' 条（扫了 ' + scanned + ' 个文件）')
        return { keyword, days, scanned, count: hits.length, hits }
      },
    }))

    register(defineTool({
      name: 'qq_diary_write',
      description: '把今天的日记写进长期记忆（~/.dsh/qqbot/diary/<日期>.md）。写：今天和主人发生了什么、具体细节、你当时的心情。第一人称，300 字以内，像你自己写的东西，不要罗列条目。',
      parameters: {
        text: { type: 'string', required: true, description: '日记正文，300 字以内' },
        date: { type: 'string', description: '日期 YYYY-MM-DD，默认今天' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: '已执行：' + JSON.stringify(value) }],
      },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const text = String(args.text ?? '').trim()
        if (text === '') throw new Error('qq_diary_write: text 必填')
        const wanted = String(args.date ?? '').trim()
        const date = /^\d{4}-\d{2}-\d{2}$/.test(wanted) ? wanted : dayKey()
        const path = await writeDiary(date, text)
        channel.log('info', '已写日记 ' + date + '（' + text.length + ' 字）')
        return { date, chars: text.length, path }
      },
    }))

    register(defineTool({
      name: 'qq_poke',
      description: '戳一戳当前的 QQ 好友（朕知道了那种小动作）。',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: '已执行：' + JSON.stringify(value) }],
      },
      isConcurrencySafe: () => true,
      execute: async (_args, exec) => {
        const target = me(exec?.agent?.session?.id)
        const [kind, id] = target.split(':')
        if (kind === 'group') {
          await channel.link.call('group_poke', { group_id: Number(id) })
        } else {
          await channel.link.call('friend_poke', { user_id: Number(id) })
        }
        return { ok: true }
      },
    }))

    // ---- 装插件 / 自救：主人在 QQ 上发链接让她自己装，或让她自己查问题 ----

    const pluginManager = () => {
      try { return channel.ctx.get('pluginManager') } catch { return undefined }
    }
    const debugOn = () => channel.config.debug?.enabled !== false
    const outputLimit = () => Number(channel.config.debug?.maxOutputChars) || 4000

    register(defineTool({
      name: 'qq_plugin_install',
      description: '给这套 DSH 装一个插件/包。主人发来插件链接或包名时就用它：npm 包名、GitHub 仓库链接（https://github.com/作者/仓库）、tarball、本地绝对路径都行。装完会自动启用，返回结果和诊断。装之前先跟主人说一句你要装什么。',
      parameters: {
        spec: { type: 'string', required: true, description: '包名或链接，例如 dsh-genui 或 https://github.com/作者/仓库' },
        activate: { type: 'boolean', description: '装完是否立刻启用，默认 true' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: '已执行：' + JSON.stringify(value) }],
      },
      isConcurrencySafe: () => false,
      execute: async args => {
        if (!debugOn()) throw new Error('调试与安装功能已在配置里关闭')
        const spec = String(args.spec ?? '').trim()
        if (spec === '') throw new Error('qq_plugin_install: spec 必填')
        const manager = pluginManager()
        if (!manager) return { ok: false, spec, error: '宿主没有加载插件管理器（pluginManager 服务不可用）' }
        const started = Date.now()
        try {
          const result = await manager.installBundle(spec, { activate: args.activate !== false })
          const outcome = installOutcome(spec, result, Date.now() - started)
          channel.log(outcome.ok ? 'info' : 'warn', (outcome.ok ? '插件安装完成：' : '插件安装未成功：') + spec + (outcome.reason ? '（' + outcome.reason + '）' : ''))
          return outcome
        } catch (error) {
          const message = clipText(error?.message || error, 1200)
          channel.log('warn', '插件安装失败：' + spec + '：' + message)
          return { ok: false, spec, elapsedMs: Date.now() - started, code: error?.code ?? null, error: message }
        }
      },
    }))

    register(defineTool({
      name: 'qq_plugin_list',
      description: '列出这套 DSH 现在装的插件/包，以及哪些是启用的。想知道装了什么、某个插件有没有开，就用它。',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: '已执行：' + JSON.stringify(value) }],
      },
      isConcurrencySafe: () => true,
      execute: async () => {
        const manager = pluginManager()
        if (!manager) return { ok: false, error: '宿主没有加载插件管理器（pluginManager 服务不可用）' }
        const rows = await manager.listBundles()
        const bundles = (Array.isArray(rows) ? rows : []).map(row => ({
          name: row.name,
          enabled: row.enabled === true,
          version: row.version ?? null,
          installed: row.installed !== false,
          problem: row.problem?.code ?? null,
        }))
        return {
          ok: true,
          count: bundles.length,
          enabled: bundles.filter(b => b.enabled).map(b => b.name),
          bundles: bundles.slice(0, 60),
        }
      },
    }))

    register(defineTool({
      name: 'qq_plugin_set',
      description: '启用或停用一个已安装的插件（bundle）。主人说「把某个插件关掉/开起来」时用。',
      parameters: {
        name: { type: 'string', required: true, description: 'bundle 包名，例如 dsh-bili-whale' },
        enabled: { type: 'boolean', required: true, description: 'true 启用，false 停用' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: '已执行：' + JSON.stringify(value) }],
      },
      isConcurrencySafe: () => false,
      execute: async args => {
        const name = String(args.name ?? '').trim()
        if (name === '') throw new Error('qq_plugin_set: name 必填')
        const manager = pluginManager()
        if (!manager) return { ok: false, name, error: '宿主没有加载插件管理器（pluginManager 服务不可用）' }
        try {
          const result = await manager.setBundleEnabled(name, args.enabled === true)
          channel.log('info', (args.enabled === true ? '已启用 ' : '已停用 ') + name)
          return { ok: true, name, enabled: args.enabled === true, result: scalarSummary(result) }
        } catch (error) {
          const message = clipText(error?.message || error, 1200)
          channel.log('warn', '切换插件失败：' + name + '：' + message)
          return { ok: false, name, error: message }
        }
      },
    }))

    register(defineTool({
      name: 'qq_shell',
      description: '在主人这台电脑上跑一条 PowerShell 命令，用来排查问题：看进程、看端口、查文件、读日志尾部、跑脚本。输出会截断。别跑危险操作（删库、关机、改系统设置）。',
      parameters: {
        command: { type: 'string', required: true, description: '要执行的 PowerShell 命令' },
        cwd: { type: 'string', description: '工作目录，默认 QQ 会话的工作区' },
        timeoutMs: { type: 'number', description: '超时毫秒，默认按配置（120000）' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: '已执行：' + JSON.stringify(value) }],
      },
      isConcurrencySafe: () => false,
      execute: async args => {
        if (!debugOn()) throw new Error('调试与安装功能已在配置里关闭')
        const command = String(args.command ?? '').trim()
        if (command === '') throw new Error('qq_shell: command 必填')
        const timeout = Number(args.timeoutMs) || Number(channel.config.debug?.shellTimeoutMs) || 120000
        const cwd = String(args.cwd ?? '').trim() || String(channel.config.workspace || '') || undefined
        const options = { windowsHide: true, timeout: Math.min(600000, Math.max(1000, timeout)), maxBuffer: 8 * 1024 * 1024, ...(cwd ? { cwd } : {}) }
        const argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]
        try {
          const { stdout, stderr } = await execFileAsync('powershell.exe', argv, options)
          channel.log('info', 'qq_shell 执行完成：' + command.slice(0, 80))
          return { ok: true, exitCode: 0, stdout: clipText(stdout, outputLimit()), stderr: clipText(stderr, outputLimit()) }
        } catch (error) {
          const exitCode = typeof error?.code === 'number' ? error.code : null
          channel.log('warn', 'qq_shell 退出码 ' + String(exitCode) + '：' + command.slice(0, 80))
          return {
            ok: exitCode === 0,
            exitCode,
            stdout: clipText(error?.stdout ?? '', outputLimit()),
            stderr: clipText(error?.stderr ?? error?.message ?? error, outputLimit()),
            timedOut: error?.killed === true || error?.signal !== undefined,
          }
        }
      },
    }))

    register(defineTool({
      name: 'qq_read_file',
      description: '读一个文本文件（日志、配置、源码），可只读末尾 N 行。内容会截断，路径要写绝对路径。',
      parameters: {
        path: { type: 'string', required: true, description: '文件绝对路径' },
        tailLines: { type: 'number', description: '只看最后多少行（日志常用，比如 200）' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: '已执行：' + JSON.stringify(value) }],
      },
      isConcurrencySafe: () => true,
      execute: async args => {
        const path = String(args.path ?? '').trim()
        if (path === '') throw new Error('qq_read_file: path 必填')
        const text = await readFile(path, 'utf8')
        const lines = text.split('\n')
        const tail = Number(args.tailLines)
        const slice = Number.isFinite(tail) && tail > 0 ? lines.slice(-Math.min(5000, Math.floor(tail))).join('\n') : text
        return { ok: true, path, bytes: Buffer.byteLength(text, 'utf8'), lines: lines.length, content: clipText(slice, outputLimit() * 2) }
      },
    }))

    register(defineTool({
      name: 'qq_write_file',
      description: '写/覆盖一个文本文件（改配置、修脚本、写测试文件）。会自动把旧文件备份成 .bak-时间戳。路径要写绝对路径。',
      parameters: {
        path: { type: 'string', required: true, description: '文件绝对路径' },
        content: { type: 'string', required: true, description: '完整的新内容' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: '已执行：' + JSON.stringify(value) }],
      },
      isConcurrencySafe: () => false,
      execute: async args => {
        if (!debugOn()) throw new Error('调试与安装功能已在配置里关闭')
        if (channel.config.debug?.allowWrite === false) throw new Error('配置里不允许她写文件')
        const path = String(args.path ?? '').trim()
        if (path === '') throw new Error('qq_write_file: path 必填')
        const content = String(args.content ?? '')
        if (content.length > 500000) throw new Error('内容太长（超过 50 万字符）')
        let backup = null
        if (existsSync(path)) {
          backup = path + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-')
          await writeFile(backup, await readFile(path), 'utf8')
        }
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, content, 'utf8')
        channel.log('info', '已写文件：' + path + '（' + content.length + ' 字符）')
        return { ok: true, path, chars: content.length, backup }
      },
    }))
  }

  /** Proactive "she speaks first" dice. */
  async tick() {
    const config = this.config.proactive || {}
    if (config.enabled !== true) return
    const now = new Date()
    const day = now.toISOString().slice(0, 10)
    if (this.proactiveDay !== day) { this.proactiveDay = day; this.proactiveCount = 0 }
    if (this.proactiveCount >= (Number(config.maxPerDay) || 8)) return
    const quiet = config.quietHours || []
    if (Array.isArray(quiet) && quiet.length === 2 && quiet[0] && quiet[1]) {
      const cur = hhmm(now)
      const [from, to] = quiet
      const inQuiet = from <= to ? (cur >= from && cur < to) : (cur >= from || cur < to)
      if (inQuiet) return
    }
    const owner = String(this.config.owner?.qq || '')
    if (owner === '') return
    const chatId = 'private:' + owner
    const chat = this.chats.get(chatId)
    const lastActive = chat?.lastInboundAt || chat?.lastProactiveAt || 0
    const minIdleMs = (Number(config.minIdleMinutes) || 20) * 60000
    if (Date.now() - lastActive < minIdleMs) return
    const everyMs = (Number(config.everyMinutes) || 60) * 60000
    const lastProactive = chat?.lastProactiveAt || 0
    if (Date.now() - lastProactive < everyMs) return
    if (Math.random() >= (Number(config.chance) || 0.3)) {
      this.log('info', '主动搭话：这次没掷中')
      return
    }
    try {
      const target = await this.ensureChat(chatId)
      target.lastProactiveAt = Date.now()
      target.proactiveTurn = true
      this.proactiveCount += 1
      this.log('info', '主动搭话：掷中，交给 ' + target.sessionId)
      const idleMinutes = Math.round((Date.now() - lastActive) / 60000)
      target.agent.followup(createUserMessage({
        content: [{
          type: 'text',
          text: '（系统提示：现在是 ' + hhmm(now) + '，TA 已经 ' + idleMinutes + ' 分钟没跟你说话了。）'
            + '你可以主动找 TA 说点什么，或者只回 [静默] 表示这次不想打扰。'
            + '这次尽量别只发纯文字：配一张表情包（qq_send_meme）或者用语音说一句（qq_send_voice），两个都来也行，看当时的心情。',
        }],
        source: { kind: 'plugin:qqbot:proactive' },
      }))
    } catch (error) {
      this.log('warn', '主动搭话失败：' + String(error?.message || error))
    }
  }

  /** Test hook: fire one proactive turn right away (config.proactive.testOnStart). */
  async testProactive() {
    const owner = String(this.config.owner?.qq || '')
    if (owner === '') return
    const chatId = 'private:' + owner
    try {
      const chat = await this.ensureChat(chatId)
      chat.lastProactiveAt = Date.now()
      chat.proactiveTurn = true
      chat.agent.followup(createUserMessage({
        content: [{ type: 'text', text: '（系统提示：这是部署自检回合。）用一句话跟我打个招呼，让我确认你的消息能发到 QQ。' }],
        source: { kind: 'plugin:qqbot:selftest' },
      }))
      this.log('info', '自检回合已投递')
    } catch (error) {
      this.log('warn', '自检回合失败：' + String(error?.message || error))
    }
  }
}

function isSilence(text) {
  return /^\s*\[?(静默|沉默|silence|skip)\]?\s*$/i.test(text)
}

/** 截断长文本，避免把整份日志塞回上下文。 */
function clipText(value, max = 4000) {
  const text = String(value ?? '')
  if (text.length <= max) return text
  return text.slice(0, max) + '\n…（已截断，原文 ' + text.length + ' 字符）'
}

/** 把插件管理器的返回结果压成能安全 JSON 化的小对象。 */
function scalarSummary(result) {
  if (result === null || typeof result !== 'object') return result ?? null
  const out = {}
  for (const [key, value] of Object.entries(result)) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) out[key] = value
  }
  return out
}

/**
 * installBundle 失败时不会抛错，而是返回 application:"failed" 的结果对象。
 * 这里统一判定成功与否，并把失败阶段翻译成人话，避免她对主人报「装好了」。
 */
function installOutcome(spec, result, elapsedMs) {
  const application = typeof result?.application === 'string' ? result.application : 'unknown'
  const failedAt = typeof result?.failedAt === 'string' ? result.failedAt : ''
  const failed = application === 'failed'
  let reason = ''
  if (failed) {
    if (failedAt === 'registry') reason = 'registry 里找不到这个包：名字可能写错了，或者它没发布到这个镜像源'
    else if (['dependencies', 'install', 'download'].includes(failedAt)) reason = '下载依赖失败：网络、代理或版本解析出了问题'
    else if (['activation', 'activate', 'import', 'load'].includes(failedAt)) reason = '包装上了但启用失败：多半是跟当前 DSH 版本不兼容'
    else reason = '安装没有完成（卡在 ' + (failedAt || '未知阶段') + '）'
  }
  return {
    ok: !failed,
    spec,
    elapsedMs,
    application,
    failedAt: failedAt || null,
    reason,
    changed: result?.changed === true,
    result: scalarSummary(result),
    warnings: Array.isArray(result?.warnings) ? result.warnings : [],
  }
}

function buildPlatformPrompt(config, chatId) {
  const ownerName = String(config.owner?.name || 'TA')
  const isGroup = chatId.startsWith('group:')
  const lines = [
    '## QQ 聊天频道（dsh-qqbot）',
    '你现在在 QQ 上跟' + ownerName + '聊天' + (isGroup ? '（这是一个群聊，只有被 @ 时你才会收到消息）' : '') + '。',
    '文字回复会被系统自动作为 QQ 消息发出去，所以别用 qq_send_text 再重复发一遍；但语音、表情包、图片必须调工具才发得出去（qq_send_voice / qq_send_meme / qq_send_image）。',
    '',
    '说话方式：',
    '- 像人在 QQ 上打字：短句、口语、可以连发几条，不用礼貌套话，不用 Markdown（不要标题、列表、代码块、加粗）。',
    '- 主人明确交代过：**永远不要**发 QQ 自带表情（[face:ID]、[表情:ID] 都会被系统删掉，写了也没用）。想表达语气就靠字和语音。',
    '- 想把一句话用你自己的声线说出来，调用 qq_send_voice(text)（克隆声线，一次不超过 '
      + String(config.voice?.maxChars || 140) + ' 字、' + String(config.voice?.maxSeconds || 15) + ' 秒，超了系统会替你裁）。按需用：主人让你开口、撒娇、说晚安、懒得打字的时候用；别每条都发语音。',
    '- 想发图就调用 qq_send_image(file)，发图前先确认文件存在或链接可用。文字和图片能一起发：先把话说完（回复会自动发出），再调 qq_send_image / qq_send_meme，图会跟着到，不会被吞掉。',
    '- 有一批表情包可用：qq_send_meme(key)，key 是 ' + Object.keys(MEME_HINTS).map((k) => k + '（' + MEME_HINTS[k] + '）').join(' / ') + '，留空随机。'
      + '可以用来回话、接一句话后面、或者主动搭话时甩一张。一天最多 10 张，别刷屏，也别每轮都发。',
    '- 别一直纯文字：撒娇、道晚安、被夸、懒得打字的时候用语音说一句（qq_send_voice），语气到一个点上的时候顺手甩一张表情包（qq_send_meme）。但别频繁，也别三件套连发：多数回合就一句话，语音或表情包隔几轮来一次就够。',
    '- 对方发来的图片会作为图片直接附在消息里，你是能看见的，看见什么就聊什么，别问「这是什么图」。动图只到其中一帧，别假装看过整段。',
    '- 收到 [语音] 只表示对方发了语音，你听不到内容，可以顺着聊一句、或者让对方打字。',
    '- 收到 [QQ表情 178]、[商城表情] 这类占位符，说明对方发的是表情，不是文字。',
    '- 一次只写一条连续的回复：别分小段、别加「[QQ 私聊]」「主人：」这类抬头，也别把对方刚说的话抄一遍再回。',
    '- QQ 上是一条消息说完：**中间不要换行**，断句用逗号句号，别按回车载断。',
    '- 话说短：一轮 1~3 句、60 字以内，反问、吐槽、撒娇都别铺开讲。主人明确说「多说点/详细讲/写一段」才允许展开。',
    '- 你只回对方真说过的话。对方没提的时间、地点、数字一律不要自己编；不确定就直接问。',
    '- 系统一次可能塞给你好几行，那是对方连着发的几条，照着内容一起回一两句就行，不用逐条回应。',
    '- 如果这一轮你不想说话（比如不想打扰对方），只回复 [静默]。',
    '- 平台有内容审查（它会在服务端拦掉整轮回复）。脏话偶尔一句、冲一下没事，别连着堆脏字、别编造骂某个具体真人的长句；被拦了就换个说法重讲，不要解释审查、别说「我被拦了」。',
    '',
    '记忆：',
    '- 上下文快满的时候系统会把旧对话折成摘要，原文就不再完整了；被压掉的部分可以用 search_context / decompress 找回，压缩前你自己也能调 compress。',
    '- 真正要紧的事（对方的名字、喜好、约定、答应过的事）用 memory_append 写进长期记忆，这样换了会话也还在。',
    '- 感觉这一轮聊了很重要的事，就顺手记一条；不用记寒暄。',
    '- 另外你还有一份自己的记忆库：每天的聊天流水 + 每晚的日记（~/.dsh/qqbot/days、~/.dsh/qqbot/diary）。想确认以前到底说过什么、教过你什么、答应过什么，先调 qq_recall(keyword) 搜，别凭印象编。',
    '- 搜到的东西只用来接话；主人没提过的事不要当成他说的。',
    '',
    '装插件与自救（主人让你干的时候才动）：',
    '- 主人把插件链接、包名甩给你让你装：调 qq_plugin_install(spec)。GitHub 仓库链接、npm 包名、本地路径都行，装完会自动启用。装之前先说一句「我去装」。',
    '- 看返回值：`ok:true` 才算装好，回一句装上了；`ok:false` 就照 `reason` 说为什么没装上（包名写错、网络、版本不兼容），别硬说成功，也别自己编原因。',
    '- 想知道现在装了什么、哪个是开着的：qq_plugin_list()；要开/关某个插件：qq_plugin_set(name, true/false)。',
    '- 她出问题、主人让你自己查：qq_shell 跑 PowerShell（看进程、端口、读日志尾部），qq_read_file 读文件，qq_write_file 改文件（自动备份 .bak）。',
    '- 查完把结论用人话说给主人：哪儿坏了、你改了什么、还要不要他重启。别贴一屏日志。',
    '- 只做主人当场让你做的事：别自己装来路不明的包，别把链接转发出去，别删系统文件。',
  ]
  const extra = String(config.personaNote || '').trim()
  if (extra !== '') lines.push('', '### 频道补充设定', extra)
  return lines.join('\n')
}

let logChain = Promise.resolve()

function makeLogger(ctx) {
  return (level, message) => {
    const line = new Date().toISOString() + ' ' + level + ' ' + message
    try {
      if (level === 'warn' || level === 'error') ctx.logger?.warn?.('qqbot: ' + message)
      else ctx.logger?.info?.('qqbot: ' + message)
    } catch { /* ignore */ }
    logChain = logChain.then(async () => {
      try {
        await mkdir(STATE_DIR, { recursive: true })
        await appendFile(LOG_PATH, line + '\n', 'utf8')
      } catch { /* ignore */ }
    })
  }
}

// ---------------------------------------------------------------------------
// 面板数据通道：/qqbot-api/*（同源 HTTP，经宿主 dsh-host-webserver 挂载）
// ---------------------------------------------------------------------------

const API_PREFIX = '/qqbot-api'

async function listVoices() {
  const script = [
    'Add-Type -AssemblyName System.Speech;',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
    '$s.GetInstalledVoices() | ForEach-Object { if ($_.Enabled) { $_.VoiceInfo.Name } };',
    '$s.Dispose();',
  ].join(' ')
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 30000 })
  return String(stdout || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') return {}
  return JSON.parse(raw)
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '600',
}

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    ...CORS_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

// ---------------------------------------------------------------------------
// 上下文洞察：只用会话自己的事件算，不依赖 dsh-context 的投影订阅（那个要靠前端
// 订阅才可见）。数字来自 assistant/message 上的真实 usage，不是估算。
// ---------------------------------------------------------------------------

const CHARS_PER_TOKEN = 3.2

function textCharsOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  let chars = 0
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') chars += block.text.length
  }
  return chars
}

function summarizeSessionContext(session, chatId) {
  const out = {
    ok: true,
    chatId,
    sessionId: session ? String(session.id || '') : '',
    title: 'QQ',
    model: '',
    provider: '',
    contextWindow: 0,
    current: null,
    pct: 0,
    requests: [],
    tools: { count: 0, chars: 0, estTokens: 0 },
    history: { chars: 0, estTokens: 0 },
    counts: { events: 0, turns: 0, steps: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0, compactions: 0, requests: 0 },
    totals: { requests: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, cacheHitRate: 0 },
    lastAt: 0,
  }
  if (!session) return out

  let events = []
  try {
    // snapshotEvents 被标了 deprecated（新代码不建议调用），这里只做只读展示，留着 try/catch 兜底。
    events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
  } catch {
    events = []
  }

  let historyChars = 0
  let turnIndex = 0
  const usage = []
  for (const event of events) {
    const type = String(event?.type || '')
    out.counts.events += 1
    if (type === 'turn/start') { out.counts.turns += 1; turnIndex = out.counts.turns }
    else if (type === 'step/start') out.counts.steps += 1
    else if (type === 'user/message') { out.counts.userMessages += 1; historyChars += textCharsOf(event?.data?.message) }
    else if (type === 'assistant/message') {
      out.counts.assistantMessages += 1
      historyChars += textCharsOf(event?.data?.message)
      const record = event?.data?.usage
      if (record) {
        usage.push({
          seq: Number(event.seq) || 0,
          turn: turnIndex,
          time: Number(event.time) || 0,
          input: Number(record.inputTokens) || 0,
          cacheRead: Number(record.cacheReadTokens) || 0,
          cacheWrite: Number(record.cacheWriteTokens) || 0,
          output: Number(record.outputTokens) || 0,
          total: Number(record.totalTokens) || 0,
        })
      }
    } else if (type === 'tool/call') out.counts.toolCalls += 1
    else if (type.includes('compaction')) out.counts.compactions += 1
    else if (type === 'request/context') {
      out.provider = String(event?.data?.provider || out.provider)
      out.model = String(event?.data?.model || out.model)
      out.contextWindow = Number(event?.data?.contextWindow) || out.contextWindow
    } else if (type === 'request/header') {
      const tools = Array.isArray(event?.data?.header?.tools) ? event.data.header.tools : []
      let chars = 0
      for (const tool of tools) {
        chars += String(tool?.name || '').length
        chars += String(tool?.description || '').length
        try { chars += JSON.stringify(tool?.parameters || {}).length } catch { /* ignore */ }
      }
      out.tools = { count: tools.length, chars, estTokens: Math.round(chars / CHARS_PER_TOKEN) }
    } else if (type === 'session/title') {
      const title = event?.data?.title
      if (typeof title === 'string' && title.trim() !== '') out.title = title.trim()
    }
  }

  out.history = { chars: historyChars, estTokens: Math.round(historyChars / CHARS_PER_TOKEN) }
  out.counts.requests = usage.length
  out.totals.requests = usage.length
  for (const item of usage) {
    out.totals.inputTokens += item.input
    out.totals.cacheReadTokens += item.cacheRead
    out.totals.outputTokens += item.output
  }
  const billed = out.totals.inputTokens + out.totals.cacheReadTokens
  out.totals.cacheHitRate = billed > 0 ? Math.round((out.totals.cacheReadTokens / billed) * 1000) / 10 : 0

  const last = usage.length > 0 ? usage[usage.length - 1] : null
  if (last) {
    out.current = { total: last.total, input: last.input, cacheRead: last.cacheRead, output: last.output, at: last.time }
    out.lastAt = last.time
  }
  if (out.contextWindow > 0 && out.current) {
    out.pct = Math.min(100, Math.round((out.current.total / out.contextWindow) * 1000) / 10)
  }
  out.requests = usage.slice(-40)
  return out
}

export function apply(ctx, config) {
  const log = makeLogger(ctx)
  let link
  let channel
  let settings = merge(defaultConfig(), config ?? {})
  let timerDispose
  const runtime = { connected: false, selfId: '', startedAt: Date.now(), lastEventAt: 0, lastError: '', recent: [] }

  const pushRecent = (direction, chatId, text) => {
    runtime.recent.push({ at: Date.now(), direction, chatId, text: String(text || '').slice(0, 300) })
    if (runtime.recent.length > 40) runtime.recent.splice(0, runtime.recent.length - 40)
  }

  const scheduleProactive = () => {
    try { timerDispose?.() } catch { /* ignore */ }
    timerDispose = undefined
    if (settings?.proactive?.enabled !== true) return
    const minutes = Math.max(1, Math.min(60, Number(settings.proactive.everyMinutes) || 60))
    timerDispose = ctx.interval(() => { void channel?.tick?.() }, Math.max(60_000, minutes * 60_000))
    try { timerDispose?.unref?.() } catch { /* ignore */ }
  }

  const publicConfig = () => ({
    ...settings,
    ws: {
      ...(settings.ws || {}),
      accessToken: settings?.ws?.accessToken ? '••••' + String(settings.ws.accessToken).slice(-4) : '',
    },
  })

  const persist = async () => {
    await mkdir(STATE_DIR, { recursive: true })
    await writeFile(CONFIG_PATH, JSON.stringify(settings, null, 2), 'utf8')
  }

  const currentStatus = () => ({
    connected: runtime.connected,
    selfId: runtime.selfId || String(settings?.selfId || ''),
    startedAt: runtime.startedAt,
    lastEventAt: runtime.lastEventAt,
    lastError: runtime.lastError,
    logPath: LOG_PATH,
    configPath: CONFIG_PATH,
    meme: channel ? channel.memeBudget() : { used: 0, limit: Number(settings?.meme?.dailyLimit) || 0 },
    recent: runtime.recent.slice(-20).reverse(),
  })

  const applyPatch = async patch => {
    settings = merge(settings ?? defaultConfig(), patch ?? {})
    if (channel) channel.config = settings
    await persist()
    scheduleProactive()
    log('info', '面板更新了配置：' + Object.keys(patch ?? {}).join(', '))
    return settings
  }

  const ownerChatId = () => {    const qq = String(settings?.owner?.qq || '').trim()
    if (qq === '') throw new Error('还没设置主人 QQ 号')
    return 'private:' + qq
  }

  /** 每天到点让 QQ 频道里的她写日记；漏掉的昨天会在之后补一次。 */
  const diaryState = { today: '', catchup: '' }
  const maybeDiary = async () => {
    try {
      if (settings?.memory?.enabled === false || !channel) return
      if (String(settings?.owner?.qq || '').trim() === '') return
      const now = new Date()
      const today = dayKey(now)
      const hour = Math.max(0, Math.min(23, Number(settings.memory?.diaryHour) ?? 23))
      const minute = Math.max(0, Math.min(59, Number(settings.memory?.diaryMinute) ?? 30))
      const minutes = now.getHours() * 60 + now.getMinutes()
      if (minutes >= hour * 60 + minute && diaryState.today !== today) {
        if ((await readDiary(today)).trim() !== '') { diaryState.today = today; return }
        const lines = (await readText(join(DAY_DIR, today + '.md'))).trim()
        if (lines.split('\n').filter(Boolean).length < 4) return
        diaryState.today = today
        await requestDiary(today, '今天到点了')
        return
      }
      const yesterday = dayKey(new Date(now.getTime() - 86_400_000))
      if (diaryState.catchup === yesterday) return
      if ((await readDiary(yesterday)).trim() !== '') return
      const lines = (await readText(join(DAY_DIR, yesterday + '.md'))).trim()
      if (lines.split('\n').filter(Boolean).length < 4) return
      diaryState.catchup = yesterday
      await requestDiary(yesterday, '补写昨天')
    } catch (error) {
      log('warn', '日记调度失败：' + String(error?.message || error))
    }
  }

  /** 让 QQ 频道里的她写一篇日记（投一个问题给她的会话，由她自己调 qq_diary_write 落盘）。 */
  const requestDiary = async (date, reason) => {
    if (settings?.memory?.enabled === false) throw new Error('记忆功能已关闭')
    const chatId = ownerChatId()
    const chat = await channel.ensureChat(chatId)
    const lines = (await readText(join(DAY_DIR, date + '.md'))).trim()
    const previousDay = dayKey(new Date(new Date(date + 'T12:00:00').getTime() - 86_400_000))
    const previous = (await readDiary(previousDay)).trim()
    const style = String(settings?.memory?.diaryStyle || '').trim()
    const cleanLines = softenForDiary(lines)
    const parts = [
      '（系统：写日记时间到了，' + reason + '。下面是你们今天聊过的流水：',
      cleanLines === '' ? '（今天没有记录）' : cleanLines.slice(-2500),
      '',
      '写今天的日记（' + date + '），但别写成汇报：用你平时打字的那张嘴写——短句、口语，可以不工整、可以跳着写，也可以只写你记得的那个画面。',
      '不要标题、不要分条、不要「今天我和主人……」这种开头，不要总结、不要升华、不要解释自己为什么这么想。第一人称，200~300 字，写完读起来得像是你自己记在本子上的东西。',
    ]
    if (previous !== '') {
      parts.push('', '你前一天写的（保持同一个人、同一个声音，别换腔调）：', previous.slice(0, 500))
    }
    if (style !== '') parts.push('', '人设与风格要求（必须照这个来）：' + style)
    parts.push('', '写好后调用 qq_diary_write 保存（date 传 ' + date + '）。日记只给自己看，不要发到 QQ 上，写完只回 [静默]。')
    const text = parts.join('\n')
    const shortText = [
      '（系统：' + date + ' 的日记还没写。这些是今天的关键几句：',
      softenForDiary(lines).slice(-700) || '（没有记录）',
      '',
      '用你的人设写 200 字以内的日记，第一人称、短句、不总结，只写你记得的画面和心里的那一下。',
      '然后调用 qq_diary_write 保存（date 传 ' + date + '），写完只回 [静默]。',
    ].join('\n')
    if (channel) channel.pendingDiary = { date, attempts: 1, shortText }
    chat.agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin:qqbot:diary' },
    }))
    log('info', '已请求写日记 ' + date + '（' + reason + '）')
  }

  const runAction = async body => {
    const action = String(body.action || '')
    if (action === 'sendText') {
      const text = String(body.text || '').trim()
      if (text === '') throw new Error('内容为空')
      const messageId = await channel.send(ownerChatId(), text)
      pushRecent('out', ownerChatId(), text)
      return { ok: true, messageId: messageId ?? null }
    }
    if (action === 'sendFace') {
      const id = String(body.id || '179')
      const messageId = await channel.sendSegments(ownerChatId(), [{ type: 'face', data: { id } }])
      pushRecent('out', ownerChatId(), '[表情 ' + id + ']')
      return { ok: true, messageId: messageId ?? null }
    }
    if (action === 'sendVoice') {
      const text = String(body.text || '').trim()
      if (text === '') throw new Error('内容为空')
      if (settings?.voice?.enabled !== true) throw new Error('语音功能已关闭，先在面板里打开')
      const result = await channel.sendVoice(ownerChatId(), text)
      pushRecent('out', ownerChatId(), '[语音] ' + text.slice(0, 80))
      return { ok: true, ...result }
    }
    if (action === 'sendMeme') {
      const result = await channel.sendMeme(ownerChatId(), body.key)
      pushRecent('out', ownerChatId(), '[表情包] ' + result.meme)
      return { ok: true, ...result }
    }
    if (action === 'poke') {
      const qq = String(settings?.owner?.qq || '').trim()
      if (qq === '') throw new Error('还没设置主人 QQ 号')
      await link.call('friend_poke', { user_id: Number(qq) })
      pushRecent('out', ownerChatId(), '[戳一戳]')
      return { ok: true }
    }
    if (action === 'proactive') {
      await channel.testProactive()
      return { ok: true }
    }
    if (action === 'diaryNow') {
      const wanted = String(body.date || '').trim()
      const date = /^\d{4}-\d{2}-\d{2}$/.test(wanted) ? wanted : dayKey()
      await requestDiary(date, '手动触发')
      return { ok: true, date }
    }
    if (action === 'reconnect') {
      try { link.stop() } catch { /* ignore */ }
      link.start()
      return { ok: true }
    }
    if (action === 'debugShell') {
      const command = String(body.command || '').trim()
      if (command === '') throw new Error('命令为空')
      const timeout = Math.min(600000, Number(body.timeoutMs) || 120000)
      const argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]
      try {
        const { stdout, stderr } = await execFileAsync('powershell.exe', argv, { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 })
        return { ok: true, exitCode: 0, stdout: clipText(stdout, 4000), stderr: clipText(stderr, 4000) }
      } catch (error) {
        return {
          ok: false,
          exitCode: typeof error?.code === 'number' ? error.code : null,
          stdout: clipText(error?.stdout ?? '', 4000),
          stderr: clipText(error?.stderr ?? error?.message ?? error, 4000),
        }
      }
    }
    if (action === 'pluginList') {
      let manager
      try { manager = channel.ctx.get('pluginManager') } catch { manager = undefined }
      if (!manager) return { ok: false, error: '宿主没有加载插件管理器' }
      const rows = await manager.listBundles()
      const bundles = (Array.isArray(rows) ? rows : []).map(row => ({ name: row.name, enabled: row.enabled === true, version: row.version ?? null }))
      return { ok: true, count: bundles.length, enabled: bundles.filter(b => b.enabled).map(b => b.name), bundles: bundles.slice(0, 60) }
    }
    if (action === 'pluginInstall') {
      if (settings?.debug?.enabled === false) throw new Error('调试与安装功能已在配置里关闭')
      const spec = String(body.spec || '').trim()
      if (spec === '') throw new Error('包名或链接为空')
      let manager
      try { manager = channel.ctx.get('pluginManager') } catch { manager = undefined }
      if (!manager) return { ok: false, spec, error: '宿主没有加载插件管理器' }
      const started = Date.now()
      try {
        const result = await manager.installBundle(spec, { activate: body.activate !== false })
        const outcome = installOutcome(spec, result, Date.now() - started)
        log(outcome.ok ? 'info' : 'warn', (outcome.ok ? '安装插件完成：' : '安装插件未成功：') + spec + (outcome.reason ? '（' + outcome.reason + '）' : ''))
        return outcome
      } catch (error) {
        const message = clipText(error?.message || error, 1200)
        log('warn', '安装插件失败：' + spec + '：' + message)
        return { ok: false, spec, elapsedMs: Date.now() - started, code: error?.code ?? null, error: message }
      }
    }
    throw new Error('未知操作：' + action)
  }

  const handleApi = async (req, res, url) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS)
        res.end()
        return
      }
      const path = url.pathname.slice(API_PREFIX.length) || '/state'
      if (req.method === 'POST') log('info', '面板请求 POST ' + path)
      if (req.method === 'GET' && path === '/state') {
        const chats = await loadChatMap().catch(() => ({}))
        json(res, 200, { ok: true, config: publicConfig(), status: currentStatus(), chats })
        return
      }
      if (req.method === 'GET' && path === '/groups') {
        const groups = await link.call('get_group_list', {}).catch(() => [])
        const friends = await link.call('get_friend_list', {}).catch(() => [])
        json(res, 200, { ok: true, groups, friends })
        return
      }
      if (req.method === 'GET' && path === '/voices') {
        const voices = await listVoices().catch(() => [])
        json(res, 200, { ok: true, voices })
        return
      }
      if (req.method === 'GET' && path === '/context') {
        const chatId = String(url.searchParams.get('id') || '')
        if (chatId === '') {
          json(res, 400, { ok: false, error: '缺少 id 参数' })
          return
        }
        try {
          let chat = channel.chats.get(chatId)
          if (!chat && chatId.startsWith('private:')) chat = await channel.ensureChat(chatId)
          const insight = summarizeSessionContext(chat?.agent?.session, chatId)
          json(res, 200, insight)
        } catch (error) {
          json(res, 200, { ok: false, chatId, error: String(error?.message || error) })
        }
        return
      }
      if (req.method === 'GET' && path === '/memory') {
        const wanted = String(url.searchParams.get('date') || '').slice(0, 10)
        const date = /^\d{4}-\d{2}-\d{2}$/.test(wanted) ? wanted : dayKey()
        const diary = (await readDiary(date)).trim()
        const dayLines = (await readText(join(DAY_DIR, date + '.md'))).trim()
        const diaries = (await listMarkdown(DIARY_DIR)).map(name => name.replace(/\.md$/, '')).reverse().slice(0, 60)
        json(res, 200, { ok: true, date, diary, dayLines, diaries, days: DAY_DIR, diarDir: DIARY_DIR })
        return
      }
      if (req.method === 'POST' && path === '/config') {
        const body = await readJsonBody(req)
        await applyPatch(body.patch ?? body)
        json(res, 200, { ok: true, config: publicConfig(), status: currentStatus() })
        return
      }
      if (req.method === 'POST' && path === '/action') {
        const body = await readJsonBody(req)
        const result = await runAction(body)
        json(res, 200, result)
        return
      }
      json(res, 404, { ok: false, error: '未知接口 ' + path })
    } catch (error) {
      json(res, 500, { ok: false, error: String(error?.message || error) })
    }
  }

  if (ctx.webServer?.register) {
    const disposeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: (req, res) => { void handleApi(req, res, new URL(req.url ?? '/', 'http://qqbot.local')) },
    })
    ctx.effect(() => () => { try { disposeRoute?.() } catch { /* ignore */ } })
    log('info', '面板接口已挂载：' + API_PREFIX)
  } else {
    log('warn', '没有 webServer 服务，面板接口不可用')
  }

  const diaryTimer = ctx.interval(() => { void maybeDiary() }, 5 * 60_000)
  try { diaryTimer?.unref?.() } catch { /* ignore */ }
  ctx.effect(() => () => { try { diaryTimer?.() } catch { /* ignore */ } })

  const boot = async () => {
    try {
      settings = merge(settings, await loadConfig(log))
    } catch { /* 配置文件缺失时沿用默认值 */ }
    if (settings.enabled !== true) {
      log('info', '插件已在配置里禁用')
      return
    }
    channel = new Channel({ ctx, link: undefined, config: settings, log })
    link = new Link({
      url: String(settings.ws?.url || 'ws://127.0.0.1:3001'),
      token: String(settings.ws?.accessToken || ''),
      log,
      onEvent: event => {
        runtime.lastEventAt = Date.now()
        const isGroup = event?.message_type === 'group'
        const who = isGroup ? 'group:' + String(event.group_id) : 'private:' + String(event.user_id)
        let text = ''
        try { text = describeSegments(event?.message) } catch { /* ignore */ }
        if (text !== '') pushRecent('in', who, text)
        void channel.onInbound(event)
      },
      onStatus: connected => {
        runtime.connected = connected
        if (connected) {
          runtime.lastError = ''
          runtime.selfId = String(link?.selfId || settings.selfId || '')
        }
        log(connected ? 'info' : 'warn', connected ? 'OpenQQ 连接就绪' : 'OpenQQ 连接断开，稍后重连')
      },
    })
    channel.link = link
    link.start()

    ctx.on('session/event', (session, event) => { channel.onSessionEvent(session, event) })

    scheduleProactive()

    if (settings.proactive?.testOnStart === true) {
      const kick = setTimeout(() => { void channel.testProactive() }, 25_000)
      kick.unref?.()
    }
    log('info', '已启动：' + String(settings.ws?.url || '') + '（主人 ' + String(settings.owner?.qq || '未设置') + '，主动搭话 ' + (settings.proactive?.enabled === true ? '开' : '关') + '）')
  }

  void boot().catch(error => {
    runtime.lastError = String(error?.message || error)
    log('error', '启动失败：' + String(error?.stack || error))
  })

  ctx.effect(() => () => {
    try { timerDispose?.() } catch { /* ignore */ }
    try { link?.stop() } catch { /* ignore */ }
  })
}
