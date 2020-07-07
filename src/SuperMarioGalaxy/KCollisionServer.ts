
import ArrayBufferSlice from "../ArrayBufferSlice";
import { vec3, ReadonlyVec3 } from "gl-matrix";
import { assertExists, nArray } from "../util";
import { isNearZero, Vec3One } from "../MathHelpers";
import { JMapInfoIter, createCsvParser } from "./JMapInfo";
import { isSameDirection } from "./ActorUtil";

export class KC_PrismData {
    public length: number = 0.0;
    public positionIdx: number = 0;
    public faceNormalIdx: number = 0;
    public edgeNormal1Idx: number = 0;
    public edgeNormal2Idx: number = 0;
    public edgeNormal3Idx: number = 0;
    public attrib: number = 0;
}

class KC_PrismHit {
    public distance: number = -1;
    public classification: number = 0;
}

const scratchVec3a = vec3.create();
const scratchVec3b = vec3.create();
const scratchVec3c = vec3.create();
const scratchVec3d = vec3.create();

class SearchBlockResult {
    public prismListOffs: number = -1;
    public shiftR: number = -1;
}

export class CheckCollideResult {
    // Galaxy effectively never uses this.
    // public bestPrism: KC_PrismData | null = null;

    public prisms: (KC_PrismData | null)[] = nArray(32, () => null);
    public distances: number[] = nArray(32, () => -1);
    public classifications: number[] = nArray(32, () => 0);

    public reset(): void {
        for (let i = 0; i < this.prisms.length; i++)
            this.prisms[i] = null;
        for (let i = 0; i < this.distances.length; i++)
            this.distances[i] = -1;
        for (let i = 0; i < this.classifications.length; i++)
            this.classifications[i] = 0;
    }
}

const searchBlockScratch = new SearchBlockResult();
const prismHitScratch = new KC_PrismHit();

export class KCollisionServer {
    private blocksTrans = vec3.create();

    private view: DataView;

    private positionsOffs: number;
    private normalsOffs: number;
    private prisms: KC_PrismData[] = [];
    private blocksOffs: number;
    private maxDistMul: number;

    private maskX: number;
    private maskY: number;
    private maskZ: number;

    private shiftR: number;
    private shiftLY: number;
    private shiftLZ: number;

    private params: JMapInfoIter | null = null;

    public farthestVertexDistance: number = 0;

    constructor(buffer: ArrayBufferSlice, paramsData: ArrayBufferSlice | null) {
        this.view = buffer.createDataView();

        this.positionsOffs = this.view.getUint32(0x00);
        this.normalsOffs = this.view.getUint32(0x04);
        const prismsOffs = this.view.getUint32(0x08);
        this.blocksOffs = this.view.getUint32(0x0C);
        this.maxDistMul = this.view.getFloat32(0x10);

        // Ignore the first prism.
        for (let offs = prismsOffs + 0x10; offs < this.blocksOffs; offs += 0x10) {
            const prism = new KC_PrismData();
            prism.length = this.view.getFloat32(offs + 0x00);
            prism.positionIdx = this.view.getUint16(offs + 0x04);
            prism.faceNormalIdx = this.view.getUint16(offs + 0x06);
            prism.edgeNormal1Idx = this.view.getUint16(offs + 0x08);
            prism.edgeNormal2Idx = this.view.getUint16(offs + 0x0A);
            prism.edgeNormal3Idx = this.view.getUint16(offs + 0x0C);
            prism.attrib = this.view.getUint16(offs + 0x0E);
            this.prisms.push(prism);
        }

        const blocksTransX = this.view.getFloat32(0x14);
        const blocksTransY = this.view.getFloat32(0x18);
        const blocksTransZ = this.view.getFloat32(0x1C);
        vec3.set(this.blocksTrans, blocksTransX, blocksTransY, blocksTransZ);

        this.maskX = this.view.getUint32(0x20);
        this.maskY = this.view.getUint32(0x24);
        this.maskZ = this.view.getUint32(0x28);

        this.shiftR = this.view.getInt32(0x2C);
        this.shiftLY = this.view.getInt32(0x30);
        this.shiftLZ = this.view.getInt32(0x34);

        if (paramsData !== null)
            this.params = createCsvParser(paramsData);
    }

    private isNearParallelNormal(prism: KC_PrismData): boolean {
        this.getEdgeNormal1(scratchVec3a, prism);
        this.getEdgeNormal2(scratchVec3b, prism);
        this.getEdgeNormal3(scratchVec3c, prism);
        return isSameDirection(scratchVec3a, scratchVec3b, 0.01) || isSameDirection(scratchVec3a, scratchVec3c, 0.01) || isSameDirection(scratchVec3b, scratchVec3c, 0.01);
    }

    public calcFarthestVertexDistance(): void {
        let bestDistSqr = 0.0;

        for (let i = 0; i < this.prisms.length; i++) {
            const prism = this.prisms[i];

            // Camera collision code is also calculated here (likely for performance)

            if (this.isNearParallelNormal(prism)) {
                // TODO(jstpierre): Flip length? Likely to just kill the plane. Not sure how much this hits in practice.
                continue;
            }

            for (let j = 0; j < 3; j++) {
                this.getPos(scratchVec3a, prism, j);
                bestDistSqr = Math.max(bestDistSqr, vec3.squaredLength(scratchVec3a));
            }
        }

        this.farthestVertexDistance = Math.sqrt(bestDistSqr);
    }

    public getAttributes(idx: number): JMapInfoIter | null {
        if (this.params !== null) {
            this.params.setRecord(this.prisms[idx].attrib);
            return this.params;
        } else {
            return null;
        }
    }

    public toIndex(prism: KC_PrismData): number {
        return this.prisms.indexOf(prism);
    }

    public getPrismData(idx: number): KC_PrismData {
        return this.prisms[idx];
    }

    public getFaceNormal(dst: vec3, prism: KC_PrismData): void {
        this.loadNormal(dst, prism.faceNormalIdx);
    }

    public getEdgeNormal1(dst: vec3, prism: KC_PrismData): void {
        this.loadNormal(dst, prism.edgeNormal1Idx);
    }

    public getEdgeNormal2(dst: vec3, prism: KC_PrismData): void {
        this.loadNormal(dst, prism.edgeNormal2Idx);
    }

    public getEdgeNormal3(dst: vec3, prism: KC_PrismData): void {
        this.loadNormal(dst, prism.edgeNormal3Idx);
    }

    public getPos(dst: vec3, prism: KC_PrismData, which: number): void {
        if (which === 0) {
            this.loadPosition(dst, prism.positionIdx);
        } else {
            if (which === 1) {
                this.loadNormal(scratchVec3a, prism.edgeNormal2Idx);
                this.loadNormal(scratchVec3b, prism.faceNormalIdx);
            } else if (which === 2) {
                this.loadNormal(scratchVec3a, prism.faceNormalIdx);
                this.loadNormal(scratchVec3b, prism.edgeNormal1Idx);
            }
            vec3.cross(scratchVec3a, scratchVec3a, scratchVec3b);

            this.loadNormal(scratchVec3b, prism.edgeNormal3Idx);
            const dist = prism.length / vec3.dot(scratchVec3a, scratchVec3b);

            this.loadPosition(scratchVec3b, prism.positionIdx);
            vec3.scaleAndAdd(dst, scratchVec3b, scratchVec3a, dist);
        }
    }

    private loadPosition(dst: vec3, idx: number): void {
        const offs = this.positionsOffs + idx * 0x0C;
        dst[0] = this.view.getFloat32(offs + 0x00);
        dst[1] = this.view.getFloat32(offs + 0x04);
        dst[2] = this.view.getFloat32(offs + 0x08);
    }

    private loadNormal(dst: vec3, idx: number): void {
        const offs = this.normalsOffs + idx * 0x0C;
        dst[0] = this.view.getFloat32(offs + 0x00);
        dst[1] = this.view.getFloat32(offs + 0x04);
        dst[2] = this.view.getFloat32(offs + 0x08);
    }

    private loadPrismListIdx(offs: number): KC_PrismData | null {
        const prismIdx = this.view.getUint16(offs);
        if (prismIdx > 0)
            return assertExists(this.prisms[prismIdx - 1]);
        else
            return null;
    }

    public checkPoint(dst: KC_PrismHit, v: ReadonlyVec3, maxDist: number): boolean {
        maxDist *= this.maxDistMul;

        const x = (v[0] - this.blocksTrans[0]) | 0;
        const y = (v[1] - this.blocksTrans[1]) | 0;
        const z = (v[2] - this.blocksTrans[2]) | 0;

        if ((x & this.maskX) !== 0 || (y & this.maskY) !== 0 || (z & this.maskZ) !== 0)
            return false;

        this.searchBlock(searchBlockScratch, x, y, z);
        let prismListIdx = searchBlockScratch.prismListOffs;

        while (true) {
            prismListIdx += 0x02;

            const prism = this.loadPrismListIdx(prismListIdx);
            if (prism === null)
                return false;

            if (prism.length <= 0.0) {
                // TODO(jstpierre): When would this happen?
                continue;
            }

            this.loadPosition(scratchVec3a, prism.positionIdx);

            // Local position.
            vec3.sub(scratchVec3a, v, scratchVec3a);

            this.loadNormal(scratchVec3b, prism.edgeNormal1Idx);
            if (vec3.dot(scratchVec3a, scratchVec3b) < 0)
                continue;

            this.loadNormal(scratchVec3b, prism.edgeNormal2Idx);
            if (vec3.dot(scratchVec3a, scratchVec3b) < 0)
                continue;

            this.loadNormal(scratchVec3b, prism.edgeNormal3Idx);
            if (vec3.dot(scratchVec3a, scratchVec3b) < prism.length)
                continue;

            this.loadNormal(scratchVec3b, prism.faceNormalIdx);
            const dist = -vec3.dot(scratchVec3b, v);
            if (dist < 0.0 || dist > maxDist)
                continue;

            // Passed all the checks.
            dst.distance = dist;
            return true;
        }
    }

    private isInsideMinMaxInLocalSpace(v: ReadonlyVec3): boolean {
        const x = (v[0] | 0), y = (v[1] | 0), z = (v[2] | 0);
        return (x & this.maskX) === 0 && (y & this.maskY) === 0 && (z & this.maskZ) === 0;
    }

    private outCheck(min: vec3, max: vec3): boolean {
        min[0] = Math.max(min[0], 0);
        min[1] = Math.max(min[1], 0);
        min[2] = Math.max(min[2], 0);
        max[0] = Math.min(max[0], (~this.maskX) >>> 0);
        max[1] = Math.min(max[1], (~this.maskY) >>> 0);
        max[2] = Math.min(max[2], (~this.maskZ) >>> 0);

        // Make sure the box is not empty.
        if (min[0] > max[0] || min[1] > max[1] || min[2] > max[2])
            return false;

        return true;
    }

    private KCHitArrow(dst: KC_PrismHit, prism: KC_PrismData, origin: ReadonlyVec3, arrowDir: ReadonlyVec3): boolean {
        this.loadNormal(scratchVec3c, prism.faceNormalIdx);

        // Local space.
        this.loadPosition(scratchVec3d, prism.positionIdx);
        vec3.sub(scratchVec3d, origin, scratchVec3d);

        const proj = vec3.dot(scratchVec3c, scratchVec3d);
        if (proj < 0.0)
            return false;

        const projDir = vec3.dot(scratchVec3c, arrowDir);
        if (proj + projDir >= 0.0)
            return false;

        const dist = proj / -projDir;
        vec3.scaleAndAdd(scratchVec3c, scratchVec3d, arrowDir, dist);

        this.loadNormal(scratchVec3d, prism.edgeNormal1Idx);
        const dotNrm1 = vec3.dot(scratchVec3c, scratchVec3d);
        if (dotNrm1 >= 0.01)
            return false;

        this.loadNormal(scratchVec3d, prism.edgeNormal2Idx);
        const dotNrm2 = vec3.dot(scratchVec3c, scratchVec3d);
        if (dotNrm2 >= 0.01)
            return false;

        this.loadNormal(scratchVec3d, prism.edgeNormal3Idx);
        const dotNrm3 = vec3.dot(scratchVec3c, scratchVec3d);
        if (dotNrm3 >= 0.01 + prism.length)
            return false;

        dst.distance = dist;
        // TODO(jstpierre): Classification. I think this is unused in Arrow collision, though.

        return true;
    }

    private KCHitSphere(dst: KC_PrismHit, prism: KC_PrismData, pos: ReadonlyVec3, radius: number, invAvgScale: number): boolean {
        const sqRadius = radius**2;

        // Local space.
        this.loadPosition(scratchVec3d, prism.positionIdx);
        vec3.sub(scratchVec3d, pos, scratchVec3d);

        this.loadNormal(scratchVec3c, prism.edgeNormal1Idx);
        const dotNrm1 = vec3.dot(scratchVec3c, scratchVec3d);
        if (dotNrm1 >= radius)
            return false;

        this.loadNormal(scratchVec3c, prism.edgeNormal2Idx);
        const dotNrm2 = vec3.dot(scratchVec3c, scratchVec3d);
        if (dotNrm2 >= radius)
            return false;

        this.loadNormal(scratchVec3c, prism.edgeNormal3Idx);
        const dotNrm3 = vec3.dot(scratchVec3c, scratchVec3d) - prism.length;
        if (dotNrm3 >= radius)
            return false;

        this.loadNormal(scratchVec3c, prism.faceNormalIdx);
        const dist = radius - vec3.dot(scratchVec3c, scratchVec3d);
        if (dist < 0.0)
            return false;

        const maxDist = this.maxDistMul * invAvgScale;
        if (dist > maxDist)
            return false;

        // TODO(jstpierre): Classification.
        dst.classification = 1;
        dst.distance = dist;
        return true;
    }

    public checkArrow(dst: CheckCollideResult, maxResults: number, origin: ReadonlyVec3, arrowDir: ReadonlyVec3): boolean {
        const blkArrowDir = vec3.copy(scratchVec3a, arrowDir);
        const blkOrigin = vec3.sub(scratchVec3b, origin, this.blocksTrans);

        let arrowLength = vec3.length(blkArrowDir);
        vec3.normalize(blkArrowDir, blkArrowDir);

        // Origin is outside, test if the arrow goes inside...
        if (!this.isInsideMinMaxInLocalSpace(blkOrigin) && blkArrowDir[0] !== 0.0) {
            const bounds = (blkArrowDir[0] > 0.0) ? 0.0 : ((~this.maskX) >>> 0);
            const length = (bounds - blkOrigin[0]) / blkArrowDir[0];
            if (length >= 0.0 && length <= arrowLength) {
                // Clip ray origin to intersection point.
                vec3.scaleAndAdd(blkOrigin, blkOrigin, blkArrowDir, length);
                arrowLength -= length;
            } else {
                return false;
            }
        }

        if (!this.isInsideMinMaxInLocalSpace(blkOrigin) && blkArrowDir[1] !== 0.0) {
            const bounds = (blkArrowDir[1] > 0.0) ? 0.0 : ((~this.maskY) >>> 0);
            const length = (bounds - blkOrigin[1]) / blkArrowDir[1];
            if (length >= 0.0 && length <= arrowLength) {
                vec3.scaleAndAdd(blkOrigin, blkOrigin, blkArrowDir, length);
                arrowLength -= length;
            } else {
                return false;
            }
        }

        if (!this.isInsideMinMaxInLocalSpace(blkOrigin) && blkArrowDir[2] !== 0.0) {
            const bounds = (blkArrowDir[2] > 0.0) ? 0.0 : ((~this.maskZ) >>> 0);
            const length = (bounds - blkOrigin[2]) / blkArrowDir[2];
            if (length >= 0.0 && length <= arrowLength) {
                vec3.scaleAndAdd(blkOrigin, blkOrigin, blkArrowDir, length);
                arrowLength -= length;
            } else {
                return false;
            }
        }

        let dstPrismCount = 0;
        while (true) {
            if (arrowLength < 0)
                return false;

            if (!this.isInsideMinMaxInLocalSpace(blkOrigin))
                return false;

            const x = (blkOrigin[0] | 0), y = (blkOrigin[1] | 0), z = (blkOrigin[2] | 0);
            this.searchBlock(searchBlockScratch, x, y, z);
            let prismListIdx = searchBlockScratch.prismListOffs;

            // let bestDist = 1.0;
            while (true) {
                prismListIdx += 0x02;

                const prism = this.loadPrismListIdx(prismListIdx);
                if (prism === null)
                    break;

                if (dst.prisms.indexOf(prism) >= 0)
                    continue;

                if (!this.KCHitArrow(prismHitScratch, prism, origin, arrowDir))
                    continue;

                /*
                if (prismHitScratch.dist < bestDist) {
                    bestDist = prismHitScratch.dist;
                    dst.bestPrism = prism;
                    dst.classification = prismHitScratch.classification;
                }
                */

                dst.prisms[dstPrismCount] = prism;
                dst.distances[dstPrismCount] = prismHitScratch.distance;
                dstPrismCount++;

                if (dstPrismCount >= maxResults) {
                    // We've filled in all the prisms. We're done.
                    return true;
                }
            }

            // If we're only looking for one prism, and we got it, we're done.
            if (dst.prisms === null /* && dst.bestPrism !== null */) {
                return true;
            } else {
                // Otherwise, continue our search along the octree to the next block.
                const mask = (1 << searchBlockScratch.shiftR) - 1;

                let minLength = 1.0E9;

                if (!isNearZero(blkArrowDir[0], 0.001)) {
                    let bounds: number;
                    if (blkArrowDir[0] >= 0.0) {
                        bounds = ((mask + 1) - (x & mask)) + 1;
                    } else {
                        bounds = -(x & mask) - 1;
                    }

                    const length = bounds / blkArrowDir[0];
                    if (length < minLength)
                        minLength = length;
                }

                if (!isNearZero(blkArrowDir[1], 0.001)) {
                    let bounds: number;
                    if (blkArrowDir[1] >= 0.0) {
                        bounds = ((mask + 1) - (y & mask)) + 1;
                    } else {
                        bounds = -(y & mask) - 1;
                    }

                    const length = bounds / blkArrowDir[1];
                    if (length < minLength)
                        minLength = length;
                }

                if (!isNearZero(blkArrowDir[2], 0.001)) {
                    let bounds: number;
                    if (blkArrowDir[2] >= 0.0) {
                        bounds = ((mask + 1) - (z & mask)) + 1;
                    } else {
                        bounds = -(z & mask) - 1;
                    }

                    const length = bounds / blkArrowDir[2];
                    if (length < minLength)
                        minLength = length;
                }

                vec3.scaleAndAdd(blkOrigin, blkOrigin, blkArrowDir, minLength);
                arrowLength -= minLength;
            }
        }
    }

    public checkSphere(dst: CheckCollideResult, maxResults: number, pos: ReadonlyVec3, radius: number, invAvgScale: number): boolean {
        // Put in local space.
        vec3.sub(scratchVec3a, pos, this.blocksTrans);

        // Compute local AABB coordinates of our required search.
        const blkMin = vec3.scaleAndAdd(scratchVec3b, scratchVec3a, Vec3One, -radius);
        const blkMax = vec3.scaleAndAdd(scratchVec3a, scratchVec3a, Vec3One, +radius);

        // Clip to AABB coordinates.
        if (!this.outCheck(blkMin, blkMax))
            return false;

        let dstPrismCount = 0;

        let advanceZ = 1000000, advanceY = 1000000;
        while (blkMin[2] < blkMax[2]) {
            while (blkMin[1] < blkMax[1]) {
                while (blkMin[0] < blkMax[0]) {
                    const x = (blkMin[0] | 0), y = (blkMin[1] | 0), z = (blkMin[2] | 0);
                    this.searchBlock(searchBlockScratch, x, y, z);

                    const bit = (1 << searchBlockScratch.shiftR);
                    const mask = bit - 1;

                    const advanceX = bit - (x & mask);
                    advanceY = Math.min(advanceY, bit - (y & mask));
                    advanceZ = Math.min(advanceZ, bit - (z & mask));

                    let prismListIdx = searchBlockScratch.prismListOffs;
                    while (true) {
                        prismListIdx += 0x02;
        
                        const prism = this.loadPrismListIdx(prismListIdx);
                        if (prism === null)
                            break;

                        if (prism.length < 0.0 || dst.prisms.indexOf(prism) >= 0)
                            continue;

                        if (!this.KCHitSphere(prismHitScratch, prism, pos, radius, invAvgScale))
                            continue;
        
                        dst.prisms[dstPrismCount] = prism;
                        dst.distances[dstPrismCount] = prismHitScratch.distance;
                        dst.classifications[dstPrismCount] = prismHitScratch.classification;
                        dstPrismCount++;

                        if (dstPrismCount >= maxResults) {
                            // We've filled in all the prisms. We're done.
                            return true;
                        }
                    }

                    blkMin[0] += advanceX;
                }
                blkMin[1] += advanceY;
            }
            blkMin[2] += advanceZ;
        }

        return dstPrismCount > 0;
    }

    private searchBlock(dst: SearchBlockResult, x: number, y: number, z: number): void {
        let blockIdx: number;

        dst.shiftR = this.shiftR;

        if (this.shiftLY === -1 && this.shiftLZ === -1) {
            blockIdx = 0;
        } else {
            blockIdx = (((x >>> dst.shiftR) | ((y >> dst.shiftR) << this.shiftLY)) | ((z >> dst.shiftR) << this.shiftLZ));
        }

        let blocksOffs = this.blocksOffs;
        while (true) {
            const res = this.view.getInt32(blocksOffs + blockIdx * 0x04);

            if (res < -1) {
                // Found result, we're good.
                dst.prismListOffs = blocksOffs + (res & 0x7FFFFFFF);
                return;
            } else {
                // Otherwise, walk further down octree.
                dst.shiftR--;

                blocksOffs += res;
                blockIdx = ((x >>> dst.shiftR) & 1) | ((((y >>> dst.shiftR) & 1) << 1)) | ((((z >>> dst.shiftR) & 1) << 2));
            }
        }
    }
}
