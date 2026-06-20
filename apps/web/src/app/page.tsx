"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { Terminal, Shield, Cpu, Activity, ArrowRight, Github } from "lucide-react";

export default function LandingPage() {
  const router = useRouter();
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    const endpoint = isLogin ? "/api/auth/login" : "/api/auth/register";
    try {
      const res = await fetch(`http://localhost:4000${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || "Authentication failed");
      }

      if (isLogin) {
        localStorage.setItem("opspilot_token", data.token);
        localStorage.setItem("opspilot_user", JSON.stringify(data.user));
        router.push("/dashboard");
      } else {
        // Switch to login card after successful registration
        setIsLogin(true);
        setError("Account created successfully! Please log in.");
      }
    } catch (err: any) {
      setError(err.message || "An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  };

  const handleGitHubConnect = () => {
    // Mock GitHub Connection flow
    alert("Redirecting to GitHub App authorization...");
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Sleek Glass Navbar */}
      <header style={{
        background: "rgba(5, 8, 17, 0.4)",
        backdropFilter: "blur(12px)",
        borderBottom: "1px solid var(--border-glass)",
        position: "sticky",
        top: 0,
        zIndex: 100
      }}>
        <div className="container" style={{
          height: "70px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between"
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div style={{
              width: "36px",
              height: "36px",
              background: "linear-gradient(135deg, var(--accent-cyan) 0%, var(--accent-purple) 100%)",
              borderRadius: "8px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center"
            }}>
              <Terminal size={18} color="#050811" />
            </div>
            <span style={{ fontFamily: "Space Grotesk", fontSize: "20px", fontWeight: "700" }}>OpsPilot <span style={{ color: "var(--accent-cyan)" }}>AI</span></span>
          </div>
          <button onClick={handleGitHubConnect} className="btn-secondary" style={{ display: "flex", alignItems: "center", gap: "8px", padding: "8px 16px" }}>
            <Github size={16} />
            Connect GitHub
          </button>
        </div>
      </header>

      {/* Main Hero & Auth Section */}
      <main className="container" style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        padding: "48px 24px"
      }}>
        <div className="grid-2">
          {/* Left Column: Visual copy & Features */}
          <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
            <div style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "8px",
              background: "rgba(0, 242, 254, 0.08)",
              border: "1px solid rgba(0, 242, 254, 0.2)",
              borderRadius: "20px",
              padding: "6px 16px",
              width: "fit-content",
              color: "var(--accent-cyan)",
              fontSize: "14px",
              fontWeight: "500"
            }}>
              <Activity size={14} />
              OpsPilot AI v4 Active Runtime
            </div>
            <h1 style={{ fontSize: "52px", lineHeight: "1.1", fontWeight: "700" }}>
              Automated Code <br />
              <span style={{
                background: "linear-gradient(135deg, var(--accent-cyan) 0%, var(--accent-purple) 100%)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent"
              }}>Reliability & Repair</span>
            </h1>
            <p style={{ color: "var(--text-secondary)", fontSize: "18px", lineHeight: "1.6" }}>
              An adapter-driven agentic platform that parses codebase architecture, builds workflows, replicates failures in sandboxes, and commits verified patches.
            </p>
            
            {/* Features Row */}
            <div style={{ display: "flex", flexDirection: "column", gap: "16px", marginTop: "12px" }}>
              <div style={{ display: "flex", gap: "16px", alignItems: "flex-start" }}>
                <div style={{ padding: "10px", background: "rgba(255,255,255,0.03)", border: "1px solid var(--border-glass)", borderRadius: "8px", color: "var(--accent-cyan)" }}>
                  <Cpu size={20} />
                </div>
                <div>
                  <h4 style={{ fontSize: "16px", marginBottom: "4px" }}>AST Architecture Graphing</h4>
                  <p style={{ color: "var(--text-muted)", fontSize: "14px" }}>Resolves cross-file compiler and symbol paths automatically.</p>
                </div>
              </div>
              
              <div style={{ display: "flex", gap: "16px", alignItems: "flex-start" }}>
                <div style={{ padding: "10px", background: "rgba(255,255,255,0.03)", border: "1px solid var(--border-glass)", borderRadius: "8px", color: "var(--accent-purple)" }}>
                  <Shield size={20} />
                </div>
                <div>
                  <h4 style={{ fontSize: "16px", marginBottom: "4px" }}>Isolated Sandbox Executions</h4>
                  <p style={{ color: "var(--text-muted)", fontSize: "14px" }}>Safely executes database migrations, services, and tests in sandbox limits.</p>
                </div>
              </div>
            </div>
          </div>

          {/* Right Column: Authentication Card */}
          <div style={{ display: "flex", justifyContent: "center" }}>
            <div className="glass-card" style={{ width: "100%", maxWidth: "420px", display: "flex", flexDirection: "column", gap: "20px" }}>
              <div style={{ textAlign: "center", marginBottom: "8px" }}>
                <h3 style={{ fontSize: "24px" }}>{isLogin ? "Sign In to OpsPilot" : "Create Account"}</h3>
                <p style={{ color: "var(--text-secondary)", fontSize: "14px", marginTop: "4px" }}>
                  {isLogin ? "Enter your credentials to manage deployments" : "Scaffold your workspace in seconds"}
                </p>
              </div>

              {error && (
                <div style={{
                  padding: "12px",
                  background: "rgba(244, 63, 94, 0.08)",
                  border: "1px solid rgba(244, 63, 94, 0.2)",
                  borderRadius: "8px",
                  color: "var(--accent-magenta)",
                  fontSize: "14px",
                  textAlign: "center"
                }}>
                  {error}
                </div>
              )}

              <form onSubmit={handleAuth} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <label style={{ fontSize: "14px", color: "var(--text-secondary)" }}>Email Address</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    placeholder="name@company.com"
                    className="glass-input"
                  />
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <label style={{ fontSize: "14px", color: "var(--text-secondary)" }}>Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    placeholder="••••••••"
                    className="glass-input"
                  />
                </div>

                <button type="submit" className="btn-primary" disabled={loading} style={{ width: "100%", marginTop: "8px" }}>
                  {loading ? "Authenticating..." : isLogin ? "Login to Dashboard" : "Register"}
                  {!loading && <ArrowRight size={16} style={{ marginLeft: "8px" }} />}
                </button>
              </form>

              <div style={{ display: "flex", justifyContent: "center", fontSize: "14px", marginTop: "8px" }}>
                <span style={{ color: "var(--text-muted)", marginRight: "6px" }}>
                  {isLogin ? "New to the platform?" : "Already have an account?"}
                </span>
                <button
                  onClick={() => { setIsLogin(!isLogin); setError(""); }}
                  style={{ background: "none", border: "none", color: "var(--accent-cyan)", fontWeight: "500", cursor: "pointer", outline: "none" }}
                >
                  {isLogin ? "Create account" : "Sign in"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Sleek Footer */}
      <footer style={{
        borderTop: "1px solid var(--border-glass)",
        padding: "24px 0",
        background: "rgba(5, 8, 17, 0.2)"
      }}>
        <div className="container" style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: "14px",
          color: "var(--text-muted)"
        }}>
          <span>&copy; 2026 OpsPilot AI. All rights reserved.</span>
          <div style={{ display: "flex", gap: "16px" }}>
            <a href="#" style={{ color: "inherit", textDecoration: "none" }}>Privacy Policy</a>
            <a href="#" style={{ color: "inherit", textDecoration: "none" }}>Terms of Service</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
