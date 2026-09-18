// Profile-photo storage for every scanned social account (Instagram, TikTok,
// YouTube).
//
// The CDN URLs that the scans store in social_accounts.profile_pic_url
// (especially Instagram's) expire after a while, so the photos rot and the
// clients show broken images. This module mirrors each profile photo to disk
// under data/avatars/ (the same directory that holds southfarm.db) and rows
// point at the local copy via the relative path /api/avatars/{filename},
// served by registerAvatarRoutes() below. Clients prepend their API base to
// relative paths; pre-existing absolute CDN URLs keep working verbatim.
//
// Everything here is best-effort: any network/format failure resolves to ''
// and simply leaves the row's profile_pic_url untouched.

import type { Express } from 'express';
import fs from 'fs';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same data/ directory that holds southfarm.db (see db.ts).
export const AVATARS_ROOT = path.join(__dirname, '..', 'data', 'avatars');

const AVATAR_MAX_BYTES = 5 * 1024 * 1024; // 5 MB cap for image downloads
const PROFILE_PAGE_MAX_BYTES = 4 * 1024 * 1024; // cap for the HTML scrape
const AVATAR_TIMEOUT_MS = 8000; // short, best-effort budget per request
const MAX_REDIRECTS = 4;
const BROWSER_UA =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
// TikTok serves complete HTML (og:image included) to crawler user agents.
const GOOGLEBOT_UA =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
// Instagram serves og:image to social-crawler UAs but a login wall to
// browser UAs.
const SOCIAL_CRAWLER_UA = 'facebookexternalhit/1.1';
// Public web App-ID Instagram expects on its i.instagram.com JSON endpoint.
const INSTAGRAM_WEB_APP_ID = '936619743392459';

const AVATAR_PLATFORMS = ['instagram', 'tiktok', 'youtube'] as const;
export type AvatarPlatform = typeof AVATAR_PLATFORMS[number];

// Filenames are generated here, so serving only needs to accept exactly this
// shape: {platform}_{sanitized username}.jpg.
const AVATAR_FILENAME_PATTERN = /^(instagram|tiktok|youtube)_[a-zA-Z0-9._-]+\.jpg$/;

export function sanitizeAvatarUsername(username: string): string {
  return String(username || '').replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function avatarFileName(platform: AvatarPlatform, username: string): string {
  return `${platform}_${sanitizeAvatarUsername(username)}.jpg`;
}

export function avatarFilePath(platform: AvatarPlatform, username: string): string {
  return path.join(AVATARS_ROOT, avatarFileName(platform, username));
}

// Relative path stored in social_accounts.profile_pic_url; clients prepend
// their API base (same convention as the publication media URLs).
export function avatarRelativeUrl(platform: AvatarPlatform, username: string): string {
  return `/api/avatars/${avatarFileName(platform, username)}`;
}

function profilePageUrl(platform: AvatarPlatform, username: string): string {
  if (platform === 'instagram') return `https://www.instagram.com/${username}/`;
  if (platform === 'tiktok') return `https://www.tiktok.com/@${username}`;
  return `https://www.youtube.com/@${username}`;
}

type HttpGetResult = { status: number; contentType: string; body: Buffer };

// Minimal https.get wrapper (no fetch in this codebase): follows up to
// maxRedirects, enforces a byte cap and a short timeout, and resolves null on
// any failure so callers can stay best-effort. extraHeaders (optional) merges
// over the defaults per call, e.g. the App-ID header the Instagram web API
// requires; the redirect chain reuses the same merged set.
function httpsGet(
  url: string,
  maxBytes: number,
  extraHeaders?: Record<string, string>,
): Promise<HttpGetResult | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: HttpGetResult | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const headers: Record<string, string> = {
      'User-Agent': BROWSER_UA,
      Accept: '*/*',
      ...(extraHeaders || {}),
    };
    const request = (target: string, redirectsLeft: number) => {
      const req = https.get(
        target,
        { headers },
        (res) => {
          const status = Number(res.statusCode || 0);
          const location = res.headers.location;
          if ([301, 302, 303, 307, 308].includes(status) && typeof location === 'string' && redirectsLeft > 0) {
            res.resume();
            let next: URL;
            try {
              next = new URL(location, target);
            } catch {
              res.resume();
              finish(null);
              return;
            }
            request(next.toString(), redirectsLeft - 1);
            return;
          }
          const contentType = String(res.headers['content-type'] || '');
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              req.destroy();
              finish(null);
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            finish(size > maxBytes ? null : { status, contentType, body: Buffer.concat(chunks) });
          });
          res.on('error', () => finish(null));
        },
      );
      req.setTimeout(AVATAR_TIMEOUT_MS, () => {
        req.destroy();
        finish(null);
      });
      req.on('error', () => finish(null));
    };
    request(url, MAX_REDIRECTS);
  });
}

// <meta property="og:image" content="..."> with either attribute order, since
// the three providers do not agree on it.
function extractOgImageUrl(html: string): string {
  for (const pattern of [
    /og:image[^>]*?content="([^"]+)"/i,
    /content="([^"]+)"[^>]*?og:image/i,
  ]) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1].replace(/&amp;/g, '&');
  }
  return '';
}

// Fallback for pages without a usable og:image: first channel avatar
// thumbnail embedded in ytInitialData.
function extractYouTubeAvatarUrl(html: string): string {
  const match = html.match(/"avatar":\{[^{}]*?"thumbnails":\[\{[^{}]*?"url":"(https:\/\/[^"]+)"/);
  if (!match?.[1]) return '';
  return match[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
}

// Same unescapes extractYouTubeAvatarUrl applies, for URLs pulled out of the
// JSON state Instagram/TikTok embed in their responses ("https:\/\/...\u0026...").
function unescapeEmbeddedUrl(url: string): string {
  return url.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
}

// Avatar URL out of the web_profile_info response: prefer the documented
// JSON shape (data.user.profile_pic_url, HD variant first). JSON.parse can
// legitimately fail on a byte-capped body, so fall back to scraping the same
// fields straight out of the raw text.
function extractInstagramAvatarFromBody(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody) as any;
    const user = parsed?.data?.user;
    if (user && typeof user === 'object') {
      const hd = typeof user.profile_pic_url_hd === 'string' ? user.profile_pic_url_hd : '';
      if (hd && /^https?:\/\//i.test(hd)) return hd;
      const sd = typeof user.profile_pic_url === 'string' ? user.profile_pic_url : '';
      if (sd && /^https?:\/\//i.test(sd)) return sd;
    }
  } catch {
    // Malformed/truncated JSON: the regex pass below still applies.
  }
  for (const pattern of [
    /"profile_pic_url_hd"\s*:\s*"(https:\\?\/\\?\/[^"]+)"/,
    /"profile_pic_url"\s*:\s*"(https:\\?\/\\?\/[^"]+)"/,
  ]) {
    const match = rawBody.match(pattern);
    if (match?.[1]) return unescapeEmbeddedUrl(match[1]);
  }
  return '';
}

// www.instagram.com/{user}/ is a login wall for our mobile-browser UA, but
// the private web API still answers with the profile JSON when called with
// the public web App-ID header.
async function fetchInstagramWebProfileUrl(username: string): Promise<string> {
  const endpoint =
    `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  const response = await httpsGet(endpoint, PROFILE_PAGE_MAX_BYTES, {
    'X-IG-App-ID': INSTAGRAM_WEB_APP_ID,
    Accept: 'application/json',
  });
  if (!response || response.status !== 200 || !response.body.length) return '';
  return extractInstagramAvatarFromBody(response.body.toString('utf8'));
}

// First avatar URL embedded in TikTok's page state: an "avatar*" key from the
// user object, then any p16-sign CDN URL (TikTok's avatar bucket).
function extractTikTokAvatarUrl(html: string): string {
  for (const pattern of [
    /"avatar[^"]*"\s*:\s*"(https:\\?\/\\?\/[^"]+)"/,
    /"(https:\\?\/\\?\/p16-sign[^"]+)"/,
  ]) {
    const match = html.match(pattern);
    if (match?.[1]) return unescapeEmbeddedUrl(match[1]);
  }
  return '';
}

// TikTok hides og:image from our browser UA, so: profile page as-is, then the
// same page as Googlebot (it serves crawlers the complete HTML), then the
// avatar URL embedded in either response's JSON state.
async function fetchTikTokProfilePicUrl(username: string): Promise<string> {
  const pageUrl = profilePageUrl('tiktok', username);
  let browserHtml = '';
  const browserResponse = await httpsGet(pageUrl, PROFILE_PAGE_MAX_BYTES);
  if (browserResponse && browserResponse.status === 200 && browserResponse.body.length) {
    browserHtml = browserResponse.body.toString('utf8');
    const ogImageUrl = extractOgImageUrl(browserHtml);
    if (ogImageUrl && /^https?:\/\//i.test(ogImageUrl)) return ogImageUrl;
  }
  const botResponse = await httpsGet(pageUrl, PROFILE_PAGE_MAX_BYTES, { 'User-Agent': GOOGLEBOT_UA });
  if (botResponse && botResponse.status === 200 && botResponse.body.length) {
    const botHtml = botResponse.body.toString('utf8');
    const botOgImageUrl = extractOgImageUrl(botHtml);
    if (botOgImageUrl && /^https?:\/\//i.test(botOgImageUrl)) return botOgImageUrl;
    const embeddedUrl = extractTikTokAvatarUrl(botHtml);
    if (embeddedUrl && /^https?:\/\//i.test(embeddedUrl)) return embeddedUrl;
  }
  if (browserHtml) {
    const embeddedUrl = extractTikTokAvatarUrl(browserHtml);
    if (embeddedUrl && /^https?:\/\//i.test(embeddedUrl)) return embeddedUrl;
  }
  return '';
}

async function fetchSourceProfilePicUrl(platform: AvatarPlatform, username: string): Promise<string> {
  if (platform === 'instagram') {
    // Instagram serves og:image to crawler UAs but a login wall to browser
    // UAs, so scrape as facebookexternalhit first; the private web API and
    // the browser-UA scrape stay as fallbacks.
    const botResponse = await httpsGet(profilePageUrl('instagram', username), PROFILE_PAGE_MAX_BYTES, {
      'User-Agent': SOCIAL_CRAWLER_UA,
    });
    if (botResponse && botResponse.status === 200 && botResponse.body.length) {
      const botOgImageUrl = extractOgImageUrl(botResponse.body.toString('utf8'));
      if (botOgImageUrl && /^https?:\/\//i.test(botOgImageUrl)) return botOgImageUrl;
    }
    const apiUrl = await fetchInstagramWebProfileUrl(username);
    if (apiUrl) return apiUrl;
    // API failed: fall through to the profile-page og:image scrape.
  }
  if (platform === 'tiktok') {
    const scraped = await fetchTikTokProfilePicUrl(username);
    if (scraped) return scraped;
    // Last resort: unavatar.io resolves TikTok avatars reliably from IPs
    // that TikTok blocks outright. Returns the image bytes itself, so
    // downloadImage() on this URL validates the content type; fallback=false
    // makes unavatars 404 (instead of serving a generic placeholder) when it
    // cannot resolve the user.
    return `https://unavatar.io/tiktok/${encodeURIComponent(username)}?fallback=false`;
  }
  const response = await httpsGet(profilePageUrl(platform, username), PROFILE_PAGE_MAX_BYTES);
  if (!response || response.status !== 200 || !response.body.length) return '';
  const html = response.body.toString('utf8');
  const ogImageUrl = extractOgImageUrl(html);
  if (ogImageUrl && /^https?:\/\//i.test(ogImageUrl)) return ogImageUrl;
  if (platform === 'youtube') {
    const avatarUrl = extractYouTubeAvatarUrl(html);
    if (avatarUrl) return avatarUrl;
  }
  return '';
}

async function downloadImage(url: string): Promise<Buffer | null> {
  const response = await httpsGet(url, AVATAR_MAX_BYTES);
  if (!response || response.status !== 200 || !response.body.length) return null;
  if (!/^image\//i.test(response.contentType)) return null;
  return response.body;
}

export function fetchInstagramProfilePicUrl(username: string): Promise<string> {
  return fetchSourceProfilePicUrl('instagram', String(username || '').replace(/^@+/, '').trim());
}

// Full pipeline for one account: returns the local /api/avatars/... path on
// success, '' when no photo could be obtained. A copy stored by a previous
// scan short-circuits the external scrape entirely, so rescans of known
// accounts never touch Instagram/TikTok/YouTube.
export async function ensureAvatarStored(platform: string, username: string): Promise<string> {
  const normalizedPlatform = String(platform || '').toLowerCase() as AvatarPlatform;
  if (!(AVATAR_PLATFORMS as readonly string[]).includes(normalizedPlatform)) return '';
  const cleanUsername = String(username || '').replace(/^@+/, '').trim();
  if (!cleanUsername) return '';

  const filePath = avatarFilePath(normalizedPlatform, cleanUsername);
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return avatarRelativeUrl(normalizedPlatform, cleanUsername);
    }
  } catch {
    // Unreadable cache entry: fall through to the network path.
  }

  const sourceUrl = await fetchSourceProfilePicUrl(normalizedPlatform, cleanUsername);
  if (!sourceUrl) return '';
  const image = await downloadImage(sourceUrl);
  if (!image) return '';
  try {
    fs.mkdirSync(AVATARS_ROOT, { recursive: true });
    fs.writeFileSync(filePath, image);
  } catch {
    return '';
  }
  return avatarRelativeUrl(normalizedPlatform, cleanUsername);
}

// GET /api/avatars/:filename — unauthenticated on purpose: clients render
// these paths directly in <img> tags where no Authorization header is sent.
export function registerAvatarRoutes(app: Express): void {
  app.get('/api/avatars/:filename', (req: any, res) => {
    const raw = String(req.params?.filename || '');
    const filename = path.basename(raw);
    // Only the exact names this module generates: rejects ../, separators,
    // odd characters, and any other extension in one shot.
    if (!filename || filename !== raw || !AVATAR_FILENAME_PATTERN.test(filename)) {
      return res.status(400).json({ error: 'invalid avatar filename' });
    }
    const filePath = path.join(AVATARS_ROOT, filename);
    try {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return res.status(404).json({ error: 'avatar not found' });
      }
    } catch {
      return res.status(404).json({ error: 'avatar not found' });
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(filePath, (error: any) => {
      if (error && !res.headersSent) {
        res.status(404).json({ error: 'avatar not found' });
      }
    });
  });
}
