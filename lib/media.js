import fs from 'node:fs';
import { spawn } from 'node:child_process';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => { err = (err + d).slice(-4000); });
    p.on('error', reject);
    p.on('close', code => code === 0
      ? resolve()
      : reject(new Error(`${cmd} exit ${code}: ${err.trim().split('\n').slice(-2).join(' ')}`)));
  });
}

let ffmpegCheck;
export function hasFfmpeg() {
  return (ffmpegCheck ??= run('ffmpeg', ['-hide_banner', '-version']).then(() => true, () => false));
}

export function probeDuration(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { windowsHide: true });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('error', reject);
    p.on('close', code => {
      const sec = parseFloat(out);
      code === 0 && Number.isFinite(sec) ? resolve(sec) : reject(new Error('ffprobe อ่านความยาววิดีโอไม่ได้'));
    });
  });
}

const exists = f =>fs.existsSync(f) && fs.statSync(f).size > 0;

// Small JPEG preview (LINE previewImageUrl must be <= 1MB)
export async function thumbnail(input, output, { width = 480, video = false } = {}) {
  if (exists(output)) return;
  const vf = `scale='min(${width},iw)':-2`;
  const base = ['-y', '-hide_banner', '-loglevel', 'error'];
  if (video) {
    // Grab a frame 1s in so we skip black intro frames; very short clips fall back to the first frame
    await run('ffmpeg', [...base, '-ss', '1', '-i', input, '-frames:v', '1', '-vf', vf, '-q:v', '4', output]).catch(() => {});
    if (exists(output)) return;
  }
  await run('ffmpeg', [...base, '-i', input, '-frames:v', '1', '-vf', vf, '-q:v', '4', output]);
}

// Convert any image to a JPEG LINE accepts (JPEG/PNG, <= 10MB)
export async function toJpeg(input, output, maxDim = 2048) {
  if (exists(output)) return;
  const vf = `scale='min(${maxDim},iw)':'min(${maxDim},ih)':force_original_aspect_ratio=decrease`;
  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-frames:v', '1', '-vf', vf, '-q:v', '3', output]);
}

// Re-wrap .mov/.webm etc. into .mp4 without re-encoding (LINE only plays mp4)
export async function remuxMp4(input, output) {
  if (exists(output)) return;
  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-c', 'copy', '-movflags', '+faststart', output]);
}
