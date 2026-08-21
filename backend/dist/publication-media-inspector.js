import { execFile } from 'node:child_process';
export function inspectPublicationVideo(file, ffprobe = process.env.SOUTHFARM_FFPROBE || 'ffprobe', run = execFile) {
    return new Promise((resolve, reject) => run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,width,height,codec_type', '-of', 'json', file], { shell: false, timeout: 10000, maxBuffer: 128 * 1024 }, (error, stdout) => {
        if (error)
            return reject(new Error('MEDIA_METADATA_INVALID'));
        try {
            const value = JSON.parse(stdout);
            const video = value.streams?.find((stream) => stream.codec_type === 'video');
            const audio = value.streams?.find((stream) => stream.codec_type === 'audio');
            const duration = Number(value.format?.duration);
            const width = video?.width;
            const height = video?.height;
            if (!video || !Number.isFinite(duration) || duration <= 0 || !Number.isInteger(width) || !Number.isInteger(height) || !width || !height || !video.codec_name)
                throw new Error('MEDIA_METADATA_INVALID');
            resolve({ duration_seconds: Math.round(duration), width, height, video_codec: video.codec_name, audio_codec: audio?.codec_name || null });
        }
        catch {
            reject(new Error('MEDIA_METADATA_INVALID'));
        }
    }));
}
