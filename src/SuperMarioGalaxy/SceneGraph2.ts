
import { Color } from "../Color";
import { DEFAULT_NUM_SAMPLES, IdentityViewportCoords } from "../gfx/helpers/RenderTargetHelpers";
import { GfxAttachment, GfxDevice, GfxFormat, GfxNormalizedViewportCoords, GfxRenderPass, GfxRenderPassDescriptor, GfxTexture, GfxTextureDimension } from "../gfx/platform/GfxPlatform";
import { assert, assertExists } from "../util";

export class RenderTargetDescription {
    public width: number = 0;
    public height: number = 0;
    public numSamples: number = 0;

    public colorClearColor: Readonly<Color> | 'load' = 'load';
    public depthClearValue: number | 'load' = 'load';
    public stencilClearValue: number | 'load' = 'load';

    constructor(public debugName: string, public pixelFormat: GfxFormat) {
    }

    public setParameters(width: number, height: number, numSamples = DEFAULT_NUM_SAMPLES): void {
        this.width = width;
        this.height = height;
        this.numSamples = numSamples;
    }
}

export const enum RenderTargetAttachmentSlot {
    Color0, DepthStencil,
}

interface SceneGraphPass {
    setDebugName(debugName: string): void;
    attachRenderTargetID(attachmentSlot: RenderTargetAttachmentSlot, renderTargetID: number): void;
    attachResolveTexture(resolveTextureID: number): void;
    exec(func: SceneGraphPassExecFunc): void;
    present(): void;
}

class SceneGraphPassImpl implements SceneGraphPass {
    // Input state used for scheduling.

    // RenderTargetAttachmentSlot => renderTargetID
    public renderTargetIDs: number[] = [];
    // RenderTargetAttachmentSlot => resolveTextureID
    public resolveTextureOutputIDs: number[] = [];
    // List of resolveTextureIDs that we have a reference to.
    public resolveTextureInputIDs: number[] = [];
    public doPresent: boolean = false;
    public viewport: GfxNormalizedViewportCoords = IdentityViewportCoords;

    public resolveTextureInputTextures: GfxTexture[] = [];

    // Execution state computed by scheduling.
    public descriptor: GfxRenderPassDescriptor = {
        colorAttachment: null,
        colorResolveTo: null,
        depthStencilAttachment: null,
        depthStencilResolveTo: null,
        colorClearColor: 'load',
        depthClearValue: 'load',
        stencilClearValue: 'load',
    };

    public viewportX: number = 0;
    public viewportY: number = 0;
    public viewportW: number = 0;
    public viewportH: number = 0;

    // Execution callback from user.
    public func: SceneGraphPassExecFunc | null = null;

    // Misc. state.
    public debugName: string;

    public setDebugName(debugName: string): void {
        this.debugName = debugName;
    }

    public attachRenderTargetID(attachmentSlot: RenderTargetAttachmentSlot, renderTargetID: number): void {
        assert(this.renderTargetIDs[attachmentSlot] === undefined);
        this.renderTargetIDs[attachmentSlot] = renderTargetID;
    }

    public attachResolveTexture(resolveTextureID: number): void {
        this.resolveTextureInputIDs.push(resolveTextureID);
    }

    public exec(func: SceneGraphPassExecFunc): void {
        assert(this.func === null);
        this.func = func;
    }

    public present(): void {
        this.doPresent = true;
    }
}

interface SceneGraphPassScope {
    getResolveTextureForID(id: number): GfxTexture;
}

type SceneGraphPassSetupFunc = (renderPass: SceneGraphPass) => void;
type SceneGraphPassExecFunc = (passRenderer: GfxRenderPass, scope: SceneGraphPassScope) => void;

class SceneGraph {
    // Used for determining scheduling.
    public renderTargetDescriptions: RenderTargetDescription[] = [];
    public resolveTextureRenderTargetIDs: number[] = [];

    public passes: SceneGraphPassImpl[] = [];
}

export class SceneGraphBuilder {
    private currentGraph: SceneGraph | null = null;

    public begin() {
        this.currentGraph = new SceneGraph();
    }

    public end(): SceneGraph {
        const sceneGraph = assertExists(this.currentGraph);
        this.currentGraph = null;
        return sceneGraph;
    }

    public pushPass(setupFunc: SceneGraphPassSetupFunc): void {
        const pass = new SceneGraphPassImpl();
        setupFunc(pass);
        this.currentGraph!.passes.push(pass);
    }

    public createRenderTargetID(desc: RenderTargetDescription): number {
        return this.currentGraph!.renderTargetDescriptions.push(desc) - 1;
    }

    private createResolveTextureID(renderTargetID: number): number {
        return this.currentGraph!.resolveTextureRenderTargetIDs.push(renderTargetID) - 1;
    }

    private findLastPassForRenderTarget(renderTargetID: number): SceneGraphPassImpl | null {
        for (let i = this.currentGraph!.passes.length - 1; i >= 0; i--) {
            const pass = this.currentGraph!.passes[i];
            if (pass.renderTargetIDs.includes(renderTargetID))
                return pass;
        }

        return null;
    }

    public resolveRenderTargetToColorTexture(renderTargetID: number): number {
        const resolveTextureID = this.createResolveTextureID(renderTargetID);

        // Find the last pass that rendered to this render target, and resolve it now.

        // If you wanted a previous snapshot copy of it, you should have created a separate,
        // intermediate pass to copy that out. Perhaps we should have a helper for this?

        // If there was no pass that wrote to this RT, well there's no point in resolving it, is there?
        const renderPass = assertExists(this.findLastPassForRenderTarget(renderTargetID));

        const attachmentSlot: RenderTargetAttachmentSlot = renderPass.renderTargetIDs.indexOf(renderTargetID);
        renderPass.resolveTextureOutputIDs[attachmentSlot] = resolveTextureID;

        return resolveTextureID;
    }
}

class ResolveTexture {
    public debugName: string;

    public readonly dimension = GfxTextureDimension.n2D;
    public readonly depth = 1;
    public readonly numLevels = 1;

    public pixelFormat: GfxFormat;
    public width: number = 0;
    public height: number = 0;

    public texture: GfxTexture;
    public age: number = 0;

    constructor(device: GfxDevice, desc: Readonly<RenderTargetDescription>) {
        this.debugName = desc.debugName;

        this.pixelFormat = desc.pixelFormat;
        this.width = desc.width;
        this.height = desc.height;

        this.texture = device.createTexture(this);
    }

    public matchesDescription(desc: Readonly<RenderTargetDescription>): boolean {
        return this.pixelFormat === desc.pixelFormat && this.width === desc.width && this.height === desc.height;
    }

    public reset(desc: Readonly<RenderTargetDescription>): void {
        assert(this.matchesDescription(desc));
        this.age = 0;
        this.debugName = desc.debugName;
    }

    public destroy(device: GfxDevice): void {
        device.destroyTexture(this.texture);
    }
}

class RenderTarget {
    public debugName: string;

    public readonly dimension = GfxTextureDimension.n2D;
    public readonly depth = 1;
    public readonly numLevels = 1;

    public pixelFormat: GfxFormat;
    public width: number = 0;
    public height: number = 0;
    public numSamples: number = 0;

    public needsClear: boolean = true;
    public texture: GfxTexture | null = null;
    public attachment: GfxAttachment;
    public age: number = 0;

    constructor(device: GfxDevice, desc: Readonly<RenderTargetDescription>) {
        this.debugName = desc.debugName;
        this.pixelFormat = desc.pixelFormat;
        this.width = desc.width;
        this.height = desc.height;
        this.numSamples = desc.numSamples;

        assert(this.numSamples >= 1);

        if (this.numSamples > 1) {
            // MSAA render targets must be backed by attachments.
            this.attachment = device.createAttachment(this);
        } else {
            // Single-sampled textures can be backed by regular textures.
            this.texture = device.createTexture(this);
            this.attachment = device.createAttachmentFromTexture(this.texture);
        }
    }

    public matchesDescription(desc: Readonly<RenderTargetDescription>): boolean {
        return this.pixelFormat === desc.pixelFormat && this.width === desc.width && this.height === desc.height && this.numSamples === desc.numSamples;
    }

    public reset(desc: Readonly<RenderTargetDescription>): void {
        assert(this.matchesDescription(desc));
        this.age = 0;
        this.debugName = desc.debugName;
    }

    public destroy(device: GfxDevice): void {
        if (this.texture !== null)
            device.destroyTexture(this.texture);
        device.destroyAttachment(this.attachment);
    }
}

function fillArray<T>(L: T[], n: number, v: T): void {
    L.length = n;
    L.fill(v);
}

export class SceneGraphExecutor {
    // For debugging and scope callbacks.
    private currentGraph: SceneGraph | null = null;
    private currentGraphPass: SceneGraphPassImpl | null = null;

    //#region Resource Creation & Caching
    private renderTargetDeadPool: RenderTarget[] = [];
    private resolveTextureDeadPool: ResolveTexture[] = [];

    private acquireRenderTargetForDescription(device: GfxDevice, desc: Readonly<RenderTargetDescription>): RenderTarget {
        for (let i = 0; i < this.renderTargetDeadPool.length; i++) {
            const freeRenderTarget = this.renderTargetDeadPool[i];
            if (freeRenderTarget.matchesDescription(desc)) {
                // Pop it off the list.
                freeRenderTarget.age = 0;
                this.renderTargetDeadPool.splice(i--, 1);
                return freeRenderTarget;
            }
        }

        // Allocate a new render target.
        return new RenderTarget(device, desc);
    }

    private acquireResolveTextureForDescription(device: GfxDevice, desc: Readonly<RenderTargetDescription>): ResolveTexture {
        for (let i = 0; i < this.resolveTextureDeadPool.length; i++) {
            const freeResolveTexture = this.resolveTextureDeadPool[i];
            if (freeResolveTexture.matchesDescription(desc)) {
                // Pop it off the list.
                freeResolveTexture.reset(desc);
                this.resolveTextureDeadPool.splice(i--, 1);
                return freeResolveTexture;
            }
        }

        // Allocate a new resolve texture.
        return new ResolveTexture(device, desc);
    }
    //#endregion

    //#region Scheduling
    private renderTargetUseCount: number[] = [];
    private resolveTextureUseCount: number[] = [];

    private renderTargetAliveForID: RenderTarget[] = [];
    private resolveTextureForID: ResolveTexture[] = [];

    private scheduleAddUseCount(graph: SceneGraph, pass: SceneGraphPassImpl): void {
        for (let i = 0; i < pass.renderTargetIDs.length; i++) {
            const renderTargetID = pass.renderTargetIDs[i];
            if (renderTargetID === undefined)
                continue;

            this.renderTargetUseCount[renderTargetID]++;
        }

        for (let i = 0; i < pass.resolveTextureInputIDs.length; i++) {
            const resolveTextureID = pass.resolveTextureInputIDs[i];
            if (resolveTextureID === undefined)
                continue;

            this.resolveTextureUseCount[resolveTextureID]++;

            const renderTargetID = graph.resolveTextureRenderTargetIDs[resolveTextureID];
            this.renderTargetUseCount[renderTargetID]++;
        }
    }

    private acquireRenderTargetForID(device: GfxDevice, graph: SceneGraph, renderTargetID: number | undefined): RenderTarget | null {
        if (renderTargetID === undefined)
            return null;

        assert(this.renderTargetUseCount[renderTargetID] > 0);

        if (!this.renderTargetAliveForID[renderTargetID]) {
            const desc = graph.renderTargetDescriptions[renderTargetID];
            this.renderTargetAliveForID[renderTargetID] = this.acquireRenderTargetForDescription(device, desc);
        }

        return this.renderTargetAliveForID[renderTargetID];
    }

    private releaseRenderTargetForID(renderTargetID: number | undefined): void {
        if (renderTargetID === undefined)
            return;

        assert(this.renderTargetUseCount[renderTargetID] > 0);

        if (--this.renderTargetUseCount[renderTargetID] === 0) {
            // This was the last reference to this RT -- steal it from the alive list, and put it back into the pool.
            const renderTarget = assertExists(this.renderTargetAliveForID[renderTargetID]);
            renderTarget.needsClear = true;

            delete this.renderTargetAliveForID[renderTargetID];
            this.renderTargetDeadPool.push(renderTarget);
        }
    }

    private acquireResolveTextureOutputForID(device: GfxDevice, graph: SceneGraph, srcRenderTargetID: number, resolveTextureID: number | undefined): GfxTexture | null {
        if (resolveTextureID === undefined)
            return null;

        assert(srcRenderTargetID === graph.resolveTextureRenderTargetIDs[resolveTextureID]);
        assert(this.resolveTextureUseCount[resolveTextureID] > 0);

        const renderTarget = assertExists(this.renderTargetAliveForID[srcRenderTargetID]);

        // No need to resolve -- we're already rendering into a texture-backed RT.
        if (renderTarget.texture !== null)
            return null;

        if (!this.resolveTextureForID[resolveTextureID]) {
            const desc = assertExists(graph.renderTargetDescriptions[srcRenderTargetID]);
            this.resolveTextureForID[resolveTextureID] = this.acquireResolveTextureForDescription(device, desc);
        }

        return this.resolveTextureForID[resolveTextureID].texture;
    }

    private acquireResolveTextureInputTextureForID(graph: SceneGraph, resolveTextureID: number): GfxTexture {
        const renderTargetID = graph.resolveTextureRenderTargetIDs[resolveTextureID];

        // First check the resolve texture pool in case we actually needed to resolve.
        const resolveTexture = this.resolveTextureForID[resolveTextureID];

        if (resolveTexture) {
            this.releaseRenderTargetForID(renderTargetID);
            return resolveTexture.texture;
        } else {
            // In this case, we should be rendering to a texture-backed RT.
            const renderTarget = assertExists(this.renderTargetAliveForID[renderTargetID]);
            this.releaseRenderTargetForID(renderTargetID);
            return assertExists(renderTarget.texture);
        }
    }

    private releaseResolveTextureInputForID(resolveTextureID: number | undefined): void {
        if (resolveTextureID === undefined)
            return;

        assert(this.resolveTextureUseCount[resolveTextureID] > 0);

        if (--this.resolveTextureUseCount[resolveTextureID] === 0) {
            // This was the last reference to this resolve texture -- put it back in the dead pool to be reused.
            // Note that we don't remove it from the for-ID pool, because it's still needed in the scope. If
            // we revise this API a bit more, then we can be a bit clearer about this.
            const resolveTexture = this.resolveTextureForID[resolveTextureID];

            // The resolve texture can be missing if we never needed to resolve to begin with.
            if (resolveTexture)
                this.resolveTextureDeadPool.push(resolveTexture);
        }
    }

    private schedulePass(device: GfxDevice, graph: SceneGraph, pass: SceneGraphPassImpl, presentColorTexture: GfxTexture | null) {
        const color0RenderTargetID = pass.renderTargetIDs[RenderTargetAttachmentSlot.Color0];
        const depthStencilRenderTargetID = pass.renderTargetIDs[RenderTargetAttachmentSlot.DepthStencil];

        const color0RenderTarget = this.acquireRenderTargetForID(device, graph, color0RenderTargetID);
        pass.descriptor.colorAttachment = color0RenderTarget !== null ? color0RenderTarget.attachment : null;
        pass.descriptor.colorClearColor = (color0RenderTarget !== null && color0RenderTarget.needsClear) ? graph.renderTargetDescriptions[color0RenderTargetID].colorClearColor : 'load';

        const depthStencilRenderTarget = this.acquireRenderTargetForID(device, graph, depthStencilRenderTargetID);
        pass.descriptor.depthStencilAttachment = depthStencilRenderTarget !== null ? depthStencilRenderTarget.attachment : null;
        pass.descriptor.depthClearValue = (depthStencilRenderTarget !== null && depthStencilRenderTarget.needsClear) ? graph.renderTargetDescriptions[depthStencilRenderTargetID].depthClearValue : 'load';
        pass.descriptor.stencilClearValue = (depthStencilRenderTarget !== null && depthStencilRenderTarget.needsClear) ? graph.renderTargetDescriptions[depthStencilRenderTargetID].stencilClearValue : 'load';

        pass.descriptor.colorResolveTo = pass.doPresent ? presentColorTexture : this.acquireResolveTextureOutputForID(device, graph, color0RenderTargetID, pass.resolveTextureOutputIDs[RenderTargetAttachmentSlot.Color0]);
        pass.descriptor.depthStencilResolveTo = this.acquireResolveTextureOutputForID(device, graph, depthStencilRenderTargetID, pass.resolveTextureOutputIDs[RenderTargetAttachmentSlot.DepthStencil]);

        if (color0RenderTarget !== null)
            color0RenderTarget.needsClear = false;
        if (depthStencilRenderTarget !== null)
            depthStencilRenderTarget.needsClear = false;

        if (color0RenderTarget !== null && depthStencilRenderTarget !== null) {
            // Parameters for all attachments must match.
            assert(color0RenderTarget.width === depthStencilRenderTarget.width);
            assert(color0RenderTarget.height === depthStencilRenderTarget.height);
            assert(color0RenderTarget.numSamples === depthStencilRenderTarget.numSamples);
        }

        let attachmentWidth = 0, attachmentHeight = 0;

        if (color0RenderTarget !== null) {
            attachmentWidth = color0RenderTarget.width;
            attachmentHeight = color0RenderTarget.height;
        } else if (depthStencilRenderTarget !== null) {
            attachmentWidth = depthStencilRenderTarget.width;
            attachmentHeight = depthStencilRenderTarget.height;
        }

        if (attachmentWidth > 0 && attachmentHeight > 0) {
            const x = attachmentWidth * pass.viewport.x;
            const y = attachmentHeight * pass.viewport.y;
            const w = attachmentWidth * pass.viewport.w;
            const h = attachmentHeight * pass.viewport.h;
            pass.viewportX = x;
            pass.viewportY = y;
            pass.viewportW = w;
            pass.viewportH = h;
        }

        for (let i = 0; i < pass.resolveTextureInputIDs.length; i++) {
            const resolveTextureID = pass.resolveTextureInputIDs[i];
            pass.resolveTextureInputTextures[i] = this.acquireResolveTextureInputTextureForID(graph, resolveTextureID);
        }

        // Now that we're done with the pass, release our resources back to the pool.
        for (let i = 0; i < pass.renderTargetIDs.length; i++)
            this.releaseRenderTargetForID(pass.renderTargetIDs[i]);
        for (let i = 0; i < pass.resolveTextureInputIDs.length; i++)
            this.releaseResolveTextureInputForID(pass.resolveTextureInputIDs[i]);
    }

    private scheduleGraph(device: GfxDevice, graph: SceneGraph, presentColorTexture: GfxTexture | null): void {
        assert(this.renderTargetUseCount.length === 0);
        assert(this.resolveTextureUseCount.length === 0);

        // Go through and increment the age of everything in our dead pools to mark that it's old.
        for (let i = 0; i < this.renderTargetDeadPool.length; i++)
            this.renderTargetDeadPool[i].age++;
        for (let i = 0; i < this.resolveTextureDeadPool.length; i++)
            this.resolveTextureDeadPool[i].age++;

        // Schedule our resources -- first, count up all uses of resources, then hand them out.

        // Initialize our accumulators.
        fillArray(this.renderTargetUseCount, graph.renderTargetDescriptions.length, 0);
        fillArray(this.resolveTextureUseCount, graph.resolveTextureRenderTargetIDs.length, 0);

        // Count.
        for (let i = 0; i < graph.passes.length; i++)
            this.scheduleAddUseCount(graph, graph.passes[i]);

        // Now hand out resources.
        for (let i = 0; i < graph.passes.length; i++)
            this.schedulePass(device, graph, graph.passes[i], presentColorTexture);

        // Double-check that all resources were handed out.
        for (let i = 0; i < this.renderTargetUseCount.length; i++)
            assert(this.renderTargetUseCount[i] === 0);
        for (let i = 0; i < this.resolveTextureUseCount.length; i++)
            assert(this.resolveTextureUseCount[i] === 0);
        for (let i = 0; i < this.renderTargetAliveForID.length; i++)
            assert(this.renderTargetAliveForID[i] === undefined);

        // Now go through and kill anything that's over our age threshold (hasn't been used in a bit)
        const ageThreshold = 1;

        for (let i = 0; i < this.renderTargetDeadPool.length; i++) {
            if (this.renderTargetDeadPool[i].age >= ageThreshold) {
                this.renderTargetDeadPool[i].destroy(device);
                this.renderTargetDeadPool.splice(i--, 1);
            }
        }

        for (let i = 0; i < this.resolveTextureDeadPool.length; i++) {
            if (this.resolveTextureDeadPool[i].age >= ageThreshold) {
                this.resolveTextureDeadPool[i].destroy(device);
                this.resolveTextureDeadPool.splice(i--, 1);
            }
        }

        // Clear out our transient scheduling state.
        this.renderTargetUseCount.length = 0;
        this.resolveTextureUseCount.length = 0;
    }
    //#endregion

    //#region Execution
    private execPass(device: GfxDevice, pass: SceneGraphPassImpl): void {
        assert(this.currentGraphPass === null);
        this.currentGraphPass = pass;

        const renderPass = device.createRenderPass(pass.descriptor);

        renderPass.setViewport(pass.viewportX, pass.viewportY, pass.viewportW, pass.viewportH);

        if (pass.func !== null)
            pass.func(renderPass, this);

        device.submitPass(renderPass);
        this.currentGraphPass = null;
    }

    public execGraph(device: GfxDevice, graph: SceneGraph, presentColorTexture: GfxTexture | null = null): void {
        // Schedule our graph.
        this.scheduleGraph(device, graph, presentColorTexture);

        assert(this.currentGraph === null);
        this.currentGraph = graph;

        for (let i = 0; i < graph.passes.length; i++)
            this.execPass(device, graph.passes[i]);

        this.currentGraph = null;

        // Clear our transient scope state.
        this.resolveTextureForID.length = 0;
    }
    //#endregion

    //#region SceneGraphPassScope
    public getResolveTextureForID(resolveTextureID: number): GfxTexture {
        const currentGraphPass = this.currentGraphPass!;
        const i = currentGraphPass.resolveTextureInputIDs.indexOf(resolveTextureID);
        assert(i >= 0);
        return assertExists(currentGraphPass.resolveTextureInputTextures[i]);
    }
    //#endregion

    public destroy(device: GfxDevice): void {
        // At the time this is called, we shouldn't have anything alive.
        for (let i = 0; i < this.renderTargetAliveForID.length; i++)
            assert(this.renderTargetAliveForID[i] === undefined);
        for (let i = 0; i < this.resolveTextureForID.length; i++)
            assert(this.resolveTextureForID[i] === undefined);

        for (let i = 0; i < this.renderTargetDeadPool.length; i++)
            this.renderTargetDeadPool[i].destroy(device);
        for (let i = 0; i < this.resolveTextureDeadPool.length; i++)
            this.resolveTextureDeadPool[i].destroy(device);
    }
}