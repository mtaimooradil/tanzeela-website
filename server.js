const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { marked } = require('marked');
// Node 18+ has built-in fetch — no extra package needed

const POSTS_DIR = path.join(__dirname, 'posts');

const app        = express();
const PORT       = process.env.PORT || 3000;
const CHANNEL_ID = 'UCV-7eC8h1vxj66eadl6y5kQ';
const RSS_URL    = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;

// Parse JSON bodies
app.use(express.json());

// Serve static files (index.html, etc.)
app.use(express.static(path.join(__dirname)));

// File where booking requests are stored
const BOOKINGS_FILE = path.join(__dirname, 'bookings.json');

function loadBookings() {
  try { return JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf8')); }
  catch { return []; }
}

function saveBookings(list) {
  fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(list, null, 2));
}

// ── Blog helpers ──────────────────────────────────────
function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  m[1].split('\n').forEach(line => {
    const idx = line.indexOf(':');
    if (idx === -1) return;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    meta[key] = val;
  });
  return { meta, body: m[2] };
}

function slugFromFilename(filename) {
  return filename.replace(/\.md$/, '');
}

function loadAllPosts() {
  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.md'));
  return files.map(file => {
    const raw  = fs.readFileSync(path.join(POSTS_DIR, file), 'utf8');
    const { meta } = parseFrontmatter(raw);
    return { slug: slugFromFilename(file), ...meta };
  }).sort((a, b) => new Date(b.date) - new Date(a.date));
}

function loadPost(slug) {
  const file = path.join(POSTS_DIR, `${slug}.md`);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  const { meta, body } = parseFrontmatter(raw);
  return { slug, ...meta, html: marked(body) };
}

// GET /api/posts — list all posts (metadata only)
app.get('/api/posts', (req, res) => {
  try {
    res.json({ posts: loadAllPosts() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/posts/:slug — single post with HTML content
app.get('/api/posts/:slug', (req, res) => {
  const post = loadPost(req.params.slug);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  res.json({ post });
});

// Blog pages — serve blog.html / post.html
app.get('/blog', (req, res) => res.sendFile(path.join(__dirname, 'blog.html')));
app.get('/blog/:slug', (req, res) => res.sendFile(path.join(__dirname, 'post.html')));

// ── Contact ───────────────────────────────────────────
app.post('/api/contact', (req, res) => {
  const { name, email, phone, sessionType, concern, message } = req.body;

  if (!name?.trim() || !email?.trim()) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }

  const entry = {
    id:          Date.now(),
    submittedAt: new Date().toISOString(),
    name:        name.trim(),
    email:       email.trim(),
    phone:       phone?.trim() || '',
    sessionType: sessionType || '',
    concern:     concern || '',
    message:     message?.trim() || '',
  };

  const bookings = loadBookings();
  bookings.unshift(entry);   // newest first
  saveBookings(bookings);

  console.log(`\n📩 New booking request from ${entry.name} <${entry.email}>`);
  console.log(`   Session: ${entry.sessionType || '—'}  |  Concern: ${entry.concern || '—'}`);
  if (entry.message) console.log(`   Message: ${entry.message}`);

  res.json({ ok: true, message: 'Booking request saved.' });
});

// Simple XML field extractor — no external XML parser needed
function extractAll(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g');
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) results.push(m[1].trim());
  return results;
}

function extractFirst(xml, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(xml);
  return m ? m[1].trim() : '';
}

function extractAttr(xml, tag, attr) {
  const m = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"[^>]*>`).exec(xml);
  return m ? m[1] : '';
}

// Cache: refresh at most once every 10 minutes
let cache = { videos: [], ts: 0 };

async function fetchVideos() {
  const now = Date.now();
  if (cache.videos.length && now - cache.ts < 10 * 60 * 1000) return cache.videos;

  const res  = await fetch(RSS_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const xml  = await res.text();

  // Each video is wrapped in an <entry> block
  const entries = extractAll(xml, 'entry');

  const videos = entries.map(entry => {
    // yt:videoId tag
    const idMatch = /<yt:videoId>([^<]+)<\/yt:videoId>/.exec(entry);
    const videoId = idMatch ? idMatch[1] : '';

    // <title> — may be CDATA
    let title = extractFirst(entry, 'title').replace(/<!\[CDATA\[|\]\]>/g, '').trim();

    // Published date
    const published = extractFirst(entry, 'published').split('T')[0];

    return { videoId, title, published };
  }).filter(v => v.videoId);

  cache = { videos, ts: now };
  return videos;
}

app.get('/api/videos', async (req, res) => {
  try {
    const videos = await fetchVideos();
    res.json({ videos });
  } catch (err) {
    console.error('RSS fetch error:', err.message);
    res.status(502).json({ error: 'Could not fetch videos', details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running → http://localhost:${PORT}`);
});
