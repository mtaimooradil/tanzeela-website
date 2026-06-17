const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const { marked } = require('marked');
const { Resend } = require('resend');

const app        = express();
const PORT       = process.env.PORT || 3000;
const CHANNEL_ID = 'UCV-7eC8h1vxj66eadl6y5kQ';
const RSS_URL    = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
const POSTS_DIR  = path.join(__dirname, 'posts');

// Resend client — requires RESEND_API_KEY env var in production
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Blog helpers ──────────────────────────────────────

function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  m[1].split('\n').forEach(line => {
    const idx = line.indexOf(':');
    if (idx === -1) return;
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  });
  return { meta, body: m[2] };
}

function loadAllPosts() {
  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.md'));
  return files.map(file => {
    const raw = fs.readFileSync(path.join(POSTS_DIR, file), 'utf8');
    const { meta } = parseFrontmatter(raw);
    return { slug: file.replace(/\.md$/, ''), ...meta };
  }).sort((a, b) => new Date(b.date) - new Date(a.date));
}

function loadPost(slug) {
  // Sanitize: only allow lowercase letters, numbers, and hyphens
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  const file = path.join(POSTS_DIR, `${slug}.md`);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  const { meta, body } = parseFrontmatter(raw);
  return { slug, ...meta, html: marked(body) };
}

app.get('/api/posts', (req, res) => {
  try { res.json({ posts: loadAllPosts() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/posts/:slug', (req, res) => {
  const post = loadPost(req.params.slug);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  res.json({ post });
});

app.get('/blog',       (req, res) => res.sendFile(path.join(__dirname, 'blog.html')));
app.get('/blog/:slug', (req, res) => res.sendFile(path.join(__dirname, 'post.html')));

// ── Contact / booking ─────────────────────────────────

app.post('/api/contact', async (req, res) => {
  const { name, email, phone, sessionType, concern, message } = req.body;

  if (!name?.trim() || !email?.trim()) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }

  const entry = {
    submittedAt: new Date().toISOString(),
    name:        name.trim(),
    email:       email.trim(),
    phone:       phone?.trim() || '—',
    sessionType: sessionType || '—',
    concern:     concern || '—',
    message:     message?.trim() || '—',
  };

  console.log(`\n📩 Booking from ${entry.name} <${entry.email}>`);
  console.log(`   Session: ${entry.sessionType}  |  Concern: ${entry.concern}`);
  if (entry.message !== '—') console.log(`   Message: ${entry.message}`);

  // Send email via Resend if API key is configured
  if (resend) {
    try {
      await resend.emails.send({
        from:    'Bookings <bookings@tanzeelakhanam.com>',
        to:      'taimooradil1998@gmail.com',
        replyTo: entry.email,
        subject: `New Booking Request — ${entry.name}`,
        html: `
          <h2 style="color:#1C3D5A">New Booking Request</h2>
          <table style="border-collapse:collapse;width:100%;font-family:sans-serif;font-size:14px">
            <tr><td style="padding:8px;color:#6B7A8A;width:140px"><b>Name</b></td><td style="padding:8px">${entry.name}</td></tr>
            <tr style="background:#f8f8f8"><td style="padding:8px;color:#6B7A8A"><b>Email</b></td><td style="padding:8px"><a href="mailto:${entry.email}">${entry.email}</a></td></tr>
            <tr><td style="padding:8px;color:#6B7A8A"><b>Phone</b></td><td style="padding:8px">${entry.phone}</td></tr>
            <tr style="background:#f8f8f8"><td style="padding:8px;color:#6B7A8A"><b>Session Type</b></td><td style="padding:8px">${entry.sessionType}</td></tr>
            <tr><td style="padding:8px;color:#6B7A8A"><b>Concern</b></td><td style="padding:8px">${entry.concern}</td></tr>
            <tr style="background:#f8f8f8"><td style="padding:8px;color:#6B7A8A"><b>Message</b></td><td style="padding:8px">${entry.message}</td></tr>
            <tr><td style="padding:8px;color:#6B7A8A"><b>Submitted</b></td><td style="padding:8px">${new Date(entry.submittedAt).toLocaleString('en-GB')}</td></tr>
          </table>
          <p style="margin-top:20px;font-size:12px;color:#999">Sent from tanzeelakhanam.com</p>
        `,
      });
      console.log('   ✉️  Email sent via Resend');
    } catch (err) {
      console.error('   Resend error:', err.message);
      // Don't fail the request — submission is still logged
    }
  } else {
    console.log('   ⚠️  RESEND_API_KEY not set — email not sent');
  }

  res.json({ ok: true });
});

// ── YouTube RSS ───────────────────────────────────────

let cache = { videos: [], ts: 0 };

async function fetchVideos() {
  const now = Date.now();
  if (cache.videos.length && now - cache.ts < 10 * 60 * 1000) return cache.videos;

  const res = await fetch(RSS_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const xml = await res.text();

  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  const videos  = [];
  let m;

  while ((m = entryRe.exec(xml)) !== null) {
    const entry   = m[1];
    const idMatch = /<yt:videoId>([^<]+)<\/yt:videoId>/.exec(entry);
    const titMatch = /<title>([^<]*)<\/title>/.exec(entry);
    const pubMatch = /<published>([^<]*)<\/published>/.exec(entry);
    if (!idMatch) continue;
    videos.push({
      videoId:   idMatch[1],
      title:     titMatch ? titMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '',
      published: pubMatch ? pubMatch[1].split('T')[0] : '',
    });
  }

  cache = { videos, ts: now };
  return videos;
}

app.get('/api/videos', async (req, res) => {
  try {
    res.json({ videos: await fetchVideos() });
  } catch (err) {
    console.error('RSS fetch error:', err.message);
    res.status(502).json({ error: 'Could not fetch videos' });
  }
});

app.listen(PORT, () => console.log(`Server running → http://localhost:${PORT}`));
