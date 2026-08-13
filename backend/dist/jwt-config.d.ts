import { JwtPayload, SignOptions } from 'jsonwebtoken';
export declare const JWT_SECRET: string;
export declare const ACCESS_TOKEN_TTL: SignOptions['expiresIn'];
export type SouthFarmJwtPayload = JwtPayload & {
    userId: number;
};
export declare function signSouthFarmJwt(userId: number): string;
export declare function verifySouthFarmJwt(token: string): SouthFarmJwtPayload;
