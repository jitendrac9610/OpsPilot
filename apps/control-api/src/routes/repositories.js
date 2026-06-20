"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.repositoryRouter = void 0;
const express_1 = require("express");
const database_1 = require("@opspilot/database");
const shared_1 = require("@opspilot/shared");
const auth_js_1 = require("../middleware/auth.js");
const unzipper_1 = __importDefault(require("unzipper"));
const router = (0, express_1.Router)();
router.use(auth_js_1.authMiddleware);
// POST /api/projects/:projectId/repositories
router.post("/projects/:projectId/repositories", async (req, res, next) => {
    try {
        const { projectId } = req.params;
        const { name, gitUrl, branch, directory } = req.body;
        if (!name || !gitUrl)
            throw new shared_1.ValidationError("name and gitUrl are required");
        // Fetch Project to confirm access
        const project = await database_1.prisma.project.findUnique({ where: { id: projectId } });
        if (!project)
            throw new shared_1.ValidationError("Project not found");
        // Auth Check
        const membership = await database_1.prisma.membership.findFirst({
            where: { organizationId: project.organizationId, userId: req.user.id }
        });
        if (!membership)
            throw new shared_1.ForbiddenError();
        const repository = await database_1.prisma.repository.create({
            data: {
                projectId,
                name,
                gitUrl,
                branch: branch || "main",
                directory: directory || "/"
            }
        });
        // Create audit log
        await database_1.prisma.auditLog.create({
            data: {
                orgId: project.organizationId,
                userId: req.user.id,
                action: "repository.connect",
                payload: { repositoryId: repository.id, name: repository.name }
            }
        });
        res.status(201).json(repository);
    }
    catch (err) {
        next(err);
    }
});
// GET /api/repositories/:id/status
router.get("/:id/status", async (req, res, next) => {
    try {
        const { id } = req.params;
        const repository = await database_1.prisma.repository.findUnique({
            where: { id },
            include: { project: true }
        });
        if (!repository)
            throw new shared_1.ValidationError("Repository not found");
        // Auth Check
        const membership = await database_1.prisma.membership.findFirst({
            where: { organizationId: repository.project.organizationId, userId: req.user.id }
        });
        if (!membership)
            throw new shared_1.ForbiddenError();
        // Check latest indexing logs
        const latestSnapshot = await database_1.prisma.repositorySnapshot.findFirst({
            where: { repositoryId: id },
            orderBy: { createdAt: "desc" }
        });
        if (!latestSnapshot) {
            return res.status(200).json({ status: "UNINDEXED", latestCommit: null });
        }
        const archVersion = await database_1.prisma.architectureVersion.findFirst({
            where: { snapshotId: latestSnapshot.id }
        });
        const status = archVersion ? "INDEXED" : "INDEXING";
        res.status(200).json({
            status,
            latestCommit: latestSnapshot.commitSha,
            indexedAt: latestSnapshot.createdAt
        });
    }
    catch (err) {
        next(err);
    }
});
// GET /api/repositories/:id/capabilities
router.get("/:id/capabilities", async (req, res, next) => {
    try {
        const { id } = req.params;
        const repository = await database_1.prisma.repository.findUnique({
            where: { id },
            include: { project: true }
        });
        if (!repository)
            throw new shared_1.ValidationError("Repository not found");
        // Auth Check
        const membership = await database_1.prisma.membership.findFirst({
            where: { organizationId: repository.project.organizationId, userId: req.user.id }
        });
        if (!membership)
            throw new shared_1.ForbiddenError();
        const latestSnapshot = await database_1.prisma.repositorySnapshot.findFirst({
            where: { repositoryId: id },
            orderBy: { createdAt: "desc" }
        });
        if (!latestSnapshot) {
            return res.status(200).json({ profile: null });
        }
        const capProfile = await database_1.prisma.capabilityProfile.findUnique({
            where: { snapshotId: latestSnapshot.id }
        });
        // Fallback: Default TS Stack profile
        res.status(200).json(capProfile || {
            snapshotId: latestSnapshot.id,
            profile: {
                languages: ["TypeScript", "JavaScript"],
                frameworks: ["Express", "Next.js"],
                databases: ["PostgreSQL", "MongoDB"],
                messaging: ["Inngest", "Redis"],
                integrations: ["Clerk", "Stripe", "GetStream"]
            }
        });
    }
    catch (err) {
        next(err);
    }
});
// GET /api/repositories/:id/architecture
router.get("/:id/architecture", async (req, res, next) => {
    try {
        const { id } = req.params;
        const repository = await database_1.prisma.repository.findUnique({
            where: { id },
            include: { project: true }
        });
        if (!repository)
            throw new shared_1.ValidationError("Repository not found");
        // Auth Check
        const membership = await database_1.prisma.membership.findFirst({
            where: { organizationId: repository.project.organizationId, userId: req.user.id }
        });
        if (!membership)
            throw new shared_1.ForbiddenError();
        const latestSnapshot = await database_1.prisma.repositorySnapshot.findFirst({
            where: { repositoryId: id },
            orderBy: { createdAt: "desc" }
        });
        if (!latestSnapshot) {
            return res.status(200).json({ nodes: [], edges: [] });
        }
        const archVersion = await database_1.prisma.architectureVersion.findFirst({
            where: { snapshotId: latestSnapshot.id },
            orderBy: { createdAt: "desc" }
        });
        if (!archVersion) {
            return res.status(200).json({ nodes: [], edges: [] });
        }
        const nodes = await database_1.prisma.graphNode.findMany({
            where: { versionId: archVersion.id }
        });
        const edges = await database_1.prisma.graphEdge.findMany({
            where: { versionId: archVersion.id }
        });
        const cleanNodes = nodes.map(node => ({
            ...node,
            id: node.id.replace(`${archVersion.id}_`, "")
        }));
        const cleanEdges = edges.map(edge => ({
            ...edge,
            id: edge.id.replace(`${archVersion.id}_`, ""),
            source: edge.source.replace(`${archVersion.id}_`, ""),
            target: edge.target.replace(`${archVersion.id}_`, "")
        }));
        res.status(200).json({ nodes: cleanNodes, edges: cleanEdges });
    }
    catch (err) {
        next(err);
    }
});
// GET /api/repositories/:id/findings
router.get("/:id/findings", async (req, res, next) => {
    try {
        const { id } = req.params;
        const repository = await database_1.prisma.repository.findUnique({
            where: { id },
            include: { project: true }
        });
        if (!repository)
            throw new shared_1.ValidationError("Repository not found");
        // Auth Check
        const membership = await database_1.prisma.membership.findFirst({
            where: { organizationId: repository.project.organizationId, userId: req.user.id }
        });
        if (!membership)
            throw new shared_1.ForbiddenError();
        const findings = await database_1.prisma.finding.findMany({
            where: { repositoryId: id }
        });
        res.status(200).json(findings);
    }
    catch (err) {
        next(err);
    }
});
// POST /api/repositories/:id/index
router.post("/:id/index", async (req, res, next) => {
    try {
        const { id } = req.params;
        const repository = await database_1.prisma.repository.findUnique({
            where: { id },
            include: { project: true }
        });
        if (!repository)
            throw new shared_1.ValidationError("Repository not found");
        // Auth Check
        const membership = await database_1.prisma.membership.findFirst({
            where: { organizationId: repository.project.organizationId, userId: req.user.id }
        });
        if (!membership)
            throw new shared_1.ForbiddenError();
        // Trigger mock webhook/indexing
        const mockWebhookUrl = `http://localhost:4001/webhooks/github`;
        // Non-blocking trigger to github-worker
        fetch(mockWebhookUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-github-event": "push"
            },
            body: JSON.stringify({
                ref: `refs/heads/${repository.branch}`,
                head_commit: { id: `manual_commit_${Date.now()}` },
                repository: { id: repository.id, clone_url: repository.gitUrl }
            })
        }).catch(err => shared_1.logger.error({ err }, "Failed to send manual push index trigger"));
        res.status(202).json({ status: "indexing_initiated" });
    }
    catch (err) {
        next(err);
    }
});
// GET /api/repositories/:id/logs
router.get("/:id/logs", async (req, res, next) => {
    try {
        const { id } = req.params;
        const repository = await database_1.prisma.repository.findUnique({
            where: { id },
            include: { project: true }
        });
        if (!repository)
            throw new shared_1.ValidationError("Repository not found");
        // Auth Check
        const membership = await database_1.prisma.membership.findFirst({
            where: { organizationId: repository.project.organizationId, userId: req.user.id }
        });
        if (!membership)
            throw new shared_1.ForbiddenError();
        const logs = await database_1.prisma.auditLog.findMany({
            where: { action: "repository.index.log" },
            orderBy: { timestamp: "asc" }
        });
        const filtered = logs
            .filter(l => l.payload?.repositoryId === id)
            .map(l => l.payload?.message);
        res.status(200).json(filtered);
    }
    catch (err) {
        next(err);
    }
});
// GET /api/repositories/:id/file?path=...
router.get("/:id/file", async (req, res, next) => {
    try {
        const { id } = req.params;
        const { path: filePath } = req.query;
        if (!filePath || typeof filePath !== "string") {
            throw new shared_1.ValidationError("path query parameter is required");
        }
        const repository = await database_1.prisma.repository.findUnique({
            where: { id },
            include: { project: true }
        });
        if (!repository)
            throw new shared_1.ValidationError("Repository not found");
        // Auth Check
        const membership = await database_1.prisma.membership.findFirst({
            where: { organizationId: repository.project.organizationId, userId: req.user.id }
        });
        if (!membership)
            throw new shared_1.ForbiddenError();
        const latestSnapshot = await database_1.prisma.repositorySnapshot.findFirst({
            where: { repositoryId: id },
            orderBy: { createdAt: "desc" }
        });
        if (!latestSnapshot) {
            throw new shared_1.ValidationError("No snapshot indexed yet for this repository");
        }
        const zipBuffer = await shared_1.storage.downloadSnapshot(latestSnapshot.archiveUrl);
        const directory = await unzipper_1.default.Open.buffer(zipBuffer);
        const cleanPath = filePath.startsWith("/") ? filePath.slice(1) : filePath;
        const file = directory.files.find(f => f.path === cleanPath || f.path === `src/${cleanPath}`);
        if (!file) {
            const fuzzyFile = directory.files.find(f => f.path.endsWith(cleanPath));
            if (!fuzzyFile) {
                return res.status(404).json({ error: "FILE_NOT_FOUND", message: `File ${filePath} not found in snapshot` });
            }
            const content = await fuzzyFile.buffer();
            return res.status(200).json({ content: content.toString() });
        }
        const content = await file.buffer();
        res.status(200).json({ content: content.toString() });
    }
    catch (err) {
        next(err);
    }
});
exports.repositoryRouter = router;
//# sourceMappingURL=repositories.js.map