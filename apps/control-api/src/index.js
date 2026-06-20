"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const shared_1 = require("@opspilot/shared");
const auth_js_1 = require("./routes/auth.js");
const orgs_js_1 = require("./routes/orgs.js");
const projects_js_1 = require("./routes/projects.js");
const billing_js_1 = require("./routes/billing.js");
const audit_js_1 = require("./routes/audit.js");
const repositories_js_1 = require("./routes/repositories.js");
const incidents_js_1 = require("./routes/incidents.js");
const app = (0, express_1.default)();
app.use((0, cors_1.default)({ origin: shared_1.config.clientUrl }));
app.use(express_1.default.json());
// Bind routing groups
app.use("/api/auth", auth_js_1.authRouter);
app.use("/api/organizations", orgs_js_1.orgRouter);
app.use("/api/projects", projects_js_1.projectRouter);
app.use("/api/repositories", repositories_js_1.repositoryRouter);
app.use("/api", billing_js_1.billingRouter);
app.use("/api/audit-logs", audit_js_1.auditRouter);
app.use("/api/incidents", incidents_js_1.incidentRouter);
// Global error handler middleware
app.use((err, req, res, next) => {
    shared_1.logger.error({ err, path: req.path }, "API error occurred");
    if (err instanceof shared_1.OpsPilotError) {
        return res.status(err.statusCode).json({
            error: err.code,
            message: err.message,
            details: err.details
        });
    }
    res.status(500).json({
        error: "INTERNAL_SERVER_ERROR",
        message: "An unexpected server-side error occurred"
    });
});
app.listen(shared_1.config.port, () => {
    shared_1.logger.info(`OpsPilot Control API listening on port ${shared_1.config.port} in ${shared_1.config.nodeEnv} mode`);
});
//# sourceMappingURL=index.js.map