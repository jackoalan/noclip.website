import { CINF } from "../cinf";
import { mat3, mat4, quat, vec3 } from "gl-matrix";
import { mat3_ext, mat4_ext } from "../../gl-matrix-ext";
import { AnimTreeNode } from "./tree_nodes";

export type PoseAsTransforms = Map<number, mat4>;

interface TreeNode {
    child: number;
    sibling: number;
    rotation: quat;
    offset: vec3;
    scale: vec3;
}

export class HierarchyPoseBuilder {
    rootId: number = 0;
    treeMap: Map<number, TreeNode> = new Map<number, TreeNode>();

    constructor(private cinf: CINF) {
        for (const boneId of cinf.buildOrder) {
            this.BuildIntoHierarchy(boneId);
        }
    }

    private BuildIntoHierarchy(boneId: number) {
        if (!this.treeMap.has(boneId)) {
            const bone = this.cinf.bones.get(boneId);
            if (bone!.parentBoneId === this.cinf.nullId) {
                this.rootId = boneId;
                const origin = this.cinf.getFromParentUnrotated(boneId);
                this.treeMap.set(boneId, {
                    child: 0,
                    sibling: 0,
                    rotation: quat.create(),
                    offset: origin,
                    scale: vec3.fromValues(1.0, 1.0, 1.0)
                });
            } else {
                this.BuildIntoHierarchy(bone!.parentBoneId);
                const origin = this.cinf.getFromParentUnrotated(boneId);
                const parentNode = this.treeMap.get(bone!.parentBoneId);
                this.treeMap.set(boneId,
                    {
                        child: 0,
                        sibling: parentNode!.child,
                        rotation: quat.create(),
                        offset: origin,
                        scale: vec3.fromValues(1.0, 1.0, 1.0)
                    });
                parentNode!.child = boneId;
            }
        }
    }

    private RecursivelyBuildNoScale(boneId: number, node: TreeNode, pose: PoseAsTransforms, parentRot: quat,
                                    parentXf: mat3, parentOffset: vec3) {
        const bindOffset = this.cinf.getFromRootUnrotated(boneId);

        const rotationFromRoot = quat.mul(quat.create(), parentRot, node.rotation);
        const rotationFromRootMat = mat3.fromQuat(mat3.create(), rotationFromRoot);

        const offsetFromRoot = vec3.transformMat3(vec3.create(), node.offset, parentXf);
        vec3.add(offsetFromRoot, offsetFromRoot, parentOffset);

        const inverseBind = mat4.fromTranslation(mat4.create(), vec3.negate(vec3.create(), boneId !== this.cinf.rootId ? bindOffset : vec3.create()));
        const xf = mat4_ext.fromMat3AndTranslate(mat4.create(), rotationFromRootMat, offsetFromRoot);
        mat4.mul(xf, xf, inverseBind);

        pose.set(boneId, xf);

        for (let bone = node.child; bone;) {
            const node = this.treeMap.get(bone);
            this.RecursivelyBuild(bone, node!, pose, rotationFromRoot, rotationFromRootMat, offsetFromRoot);
            bone = node!.sibling;
        }
    }

    private RecursivelyBuild(boneId: number, node: TreeNode, pose: PoseAsTransforms, parentRot: quat,
                             parentXf: mat3, parentOffset: vec3) {
        const bindOffset = this.cinf.getFromRootUnrotated(boneId);

        const rotationFromRoot = quat.mul(quat.create(), parentRot, node.rotation);
        const rotationFromRootMat = mat3.fromQuat(mat3.create(), rotationFromRoot);
        const rotationScale = mat3_ext.scale3(mat3.create(), rotationFromRootMat, node.scale);

        const offsetFromRoot = vec3.transformMat3(vec3.create(), node.offset, parentXf);
        vec3.add(offsetFromRoot, offsetFromRoot, parentOffset);

        const inverseBind = mat4.fromTranslation(mat4.create(), vec3.negate(vec3.create(), boneId !== this.cinf.rootId ? bindOffset : vec3.create()));
        const xf = mat4_ext.fromMat3AndTranslate(mat4.create(), rotationScale, offsetFromRoot);
        mat4.mul(xf, xf, inverseBind);

        pose.set(boneId, xf);

        for (let bone = node.child; bone;) {
            const node = this.treeMap.get(bone);
            this.RecursivelyBuild(bone, node!, pose, rotationFromRoot, rotationFromRootMat, offsetFromRoot);
            bone = node!.sibling;
        }
    }

    private BuildNoScale(): PoseAsTransforms {
        const pose = new Map<number, mat4>();
        const root = this.treeMap.get(this.rootId);
        const parentRot = quat.create();
        const parentXf = mat3.create();
        const parentOffset = vec3.create();
        this.RecursivelyBuildNoScale(this.rootId, root!, pose, parentRot, parentXf, parentOffset);
        return pose;
    }

    BuildFromAnimRoot(animRoot: AnimTreeNode): PoseAsTransforms {
        const data = animRoot.GetPerSegmentData(this.cinf.buildOrder);

        for (let i = 0; i < this.cinf.buildOrder.length; ++i) {
            const boneId = this.cinf.buildOrder[i];
            if (boneId == this.cinf.rootId)
                continue;
            const node = this.treeMap.get(boneId);
            const {rotation, scale, translation} = data[i];
            node!.rotation = rotation ? rotation : quat.create();
            node!.offset = translation ? translation : this.cinf.getFromParentUnrotated(boneId);
            node!.scale = scale ? scale : vec3.fromValues(1.0, 1.0, 1.0);
        }

        return this.BuildNoScale();
    }
}
