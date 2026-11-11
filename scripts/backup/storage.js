#!/usr/bin/env node
/**
 * scripts/backup/storage.js -- copy every file in Supabase Storage.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/backup/storage.js download ./out/storage
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/backup/storage.js upload   ./out/storage
 *
 * Supabase's own database backups do not include Storage files (uploaded
 * invoices, promotion images, logos, ShopSafe attachments), so they are copied
 * here. `download` is read-only on Supabase and writes storage-manifest.json
 * (files and bytes per bucket) beside the files. `upload` is for a restore into
 * a NEW project: it creates missing buckets (same public/private setting) and
 * uploads every file, never overwriting one that is already there.
 */
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const [, , mode, dirArg] = process.argv;
const dir = path.resolve(dirArg || './backup-out/storage');
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key || !['download', 'upload'].includes(mode)) {
    console.error('Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/backup/storage.js download|upload <dir>');
    process.exit(2);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

/** Every file path in a bucket (folders are walked; Storage lists one level at a time). */
async function listAll(bucket, prefix = '') {
    const out = [];
    for (let offset = 0; ; offset += 1000) {
        const { data, error } = await sb.storage.from(bucket).list(prefix, { limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } });
        if (error) throw new Error(`${bucket}/${prefix}: ${error.message}`);
        for (const e of data || []) {
            const p = prefix ? `${prefix}/${e.name}` : e.name;
            if (e.id === null || e.id === undefined) out.push(...await listAll(bucket, p));   // a folder
            else out.push({ path: p, size: (e.metadata && e.metadata.size) || 0 });
        }
        if (!data || data.length < 1000) break;
    }
    return out;
}

function safeJoin(base, rel) {
    const target = path.resolve(base, rel);
    if (target !== base && !target.startsWith(base + path.sep)) throw new Error(`Refusing path outside the backup folder: ${rel}`);
    return target;
}

async function download() {
    const { data: buckets, error } = await sb.storage.listBuckets();
    if (error) throw error;
    const manifest = { generated_at: new Date().toISOString(), buckets: {} };
    for (const b of buckets) {
        const files = await listAll(b.id);
        let bytes = 0;
        for (const f of files) {
            const { data: blob, error: dErr } = await sb.storage.from(b.id).download(f.path);
            if (dErr) throw new Error(`${b.id}/${f.path}: ${dErr.message}`);
            const buf = Buffer.from(await blob.arrayBuffer());
            const target = safeJoin(path.join(dir, b.id), f.path);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, buf);
            bytes += buf.length;
        }
        manifest.buckets[b.id] = { public: !!b.public, files: files.length, bytes };
        console.log(`  ${b.id}: ${files.length} file(s), ${bytes} bytes`);
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '..', 'storage-manifest.json'), JSON.stringify(manifest, null, 2));
}

function walk(d, base = d) {
    const out = [];
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) out.push(...walk(p, base)); else out.push(path.relative(base, p).split(path.sep).join('/'));
    }
    return out;
}

async function upload() {
    const manifestPath = path.join(dir, '..', 'storage-manifest.json');
    const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { buckets: {} };
    const { data: existing } = await sb.storage.listBuckets();
    const have = new Set((existing || []).map(b => b.id));
    for (const bucket of fs.readdirSync(dir)) {
        if (!have.has(bucket)) {
            const isPublic = !!(manifest.buckets[bucket] && manifest.buckets[bucket].public);
            const { error } = await sb.storage.createBucket(bucket, { public: isPublic });
            if (error) throw new Error(`create ${bucket}: ${error.message}`);
        }
        const files = walk(path.join(dir, bucket));
        for (const f of files) {
            const { error } = await sb.storage.from(bucket).upload(f, fs.readFileSync(path.join(dir, bucket, f)), { upsert: false });
            if (error && !/exists|Duplicate/i.test(error.message)) throw new Error(`${bucket}/${f}: ${error.message}`);
        }
        console.log(`  ${bucket}: ${files.length} file(s) uploaded`);
    }
}

(mode === 'download' ? download() : upload()).catch(err => { console.error('Storage backup failed:', err.message || err); process.exit(1); });
