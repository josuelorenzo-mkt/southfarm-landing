import { execFile } from 'node:child_process';
export type PublicationMediaMetadata = {
    duration_seconds: number;
    width: number;
    height: number;
    video_codec: string;
    audio_codec: string | null;
};
export declare function inspectPublicationVideo(file: string, ffprobe?: string, run?: typeof execFile): Promise<PublicationMediaMetadata>;
