// README screenshot capture (Playwright, headless).
//
// Prerequisite: the stack is running (`docker compose up`) with the demo seed.
//   cd scripts/capture-screenshots
//   npm install && npx playwright install chromium
//   node capture.mjs            # BASE_URL=http://localhost:3000 by default
//
// Output: <repo>/image/*.png at 1440x900.
//
// AI features need a user's Gemini key. No real key is used here: the AI
// endpoints the screens call (home suggestions, overseer stream) are answered
// by route mocks below, and localStorage holds a dummy value only so the UI
// enables those controls. The key itself is never shown on screen.

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../image");
const VIEWPORT = { width: 1440, height: 900 };
const PASSWORD = "demo1234";
const DUMMY_KEY = "dummy-key-for-screenshots";

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});

async function newPage() {
  const ctx = await browser.newContext({ viewport: VIEWPORT, locale: "ko-KR" });
  await ctx.addInitScript(() => {
    try {
      // Skip the one-time "enter your key" prompt so screens are unobstructed.
      sessionStorage.setItem("nodi-gemini-key-prompted", "1");
    } catch {}
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.warn("  page error:", e.message));
  return { ctx, page };
}

async function login(page, username) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel("아이디").fill(username);
  await page.getByLabel("비밀번호", { exact: true }).fill(PASSWORD);
  await page.locator("form").getByRole("button", { name: "로그인" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
}

// Wait for data requests and d3 transitions to settle before capturing.
async function settle(page, ms = 1200) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(ms);
}

async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log("saved", path.relative(process.cwd(), file));
}

// ── Mock responses for AI endpoints (classification C) ───────────────────
const MOCK_SUGGESTIONS = [
  "연쇄법칙은 왜 성립할까?",
  "광합성과 세포 호흡의 에너지 흐름을 비교해 줘",
  "리스트 컴프리헨션과 제너레이터 표현식의 차이는?",
];

async function mockAi(page, userId) {
  await page.route("**/api/home/suggestions**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        suggestions: MOCK_SUGGESTIONS.map((q) => ({
          question: q,
          seed_question: q,
          space_kind: "personal",
          space_ref: userId,
        })),
      }),
    }),
  );
  await page.route("**/api/overseer/stream**", async (route) => {
    const sessions = await page.evaluate(async () => {
      const r = await fetch("/api/sessions?space_kind=personal", { credentials: "include" });
      return r.ok ? r.json() : [];
    });
    const calculus = sessions.find((s) => (s.title || "").includes("미분"));
    const text =
      "미분 공부는 **미분의 기초** 대화에 이어서 하면 좋아요. 도함수 개념부터 연쇄법칙까지 정리돼 있어요. " +
      "적분으로 넘어가려면 새 대화를 만들어 드릴게요.";
    const actions = [
      ...(calculus ? [{ action: "open_session", label: "미분의 기초 열기", session_id: calculus.id }] : []),
      {
        action: "create_session",
        label: "적분 입문 대화 만들기",
        space_kind: "personal",
        space_ref: userId,
        seed_question: "부정적분과 정적분의 차이는?",
      },
    ];
    const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const body =
      sse("start", {}) +
      text.match(/.{1,12}/gs).map((delta) => sse("token", { delta })).join("") +
      sse("done", { actions });
    await route.fulfill({ status: 200, contentType: "text/event-stream", body });
  });
}

// ── Student (demo) ────────────────────────────────────────────────────────
{
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/login`);
  await settle(page, 500);
  await shot(page, "landing-login");

  await login(page, "demo");
  await settle(page);

  // Gemini API key dialog (empty: nothing sensitive on screen)
  await page.getByRole("button", { name: "Gemini API 키" }).first().click();
  await page.getByRole("dialog").waitFor();
  await settle(page, 500);
  await shot(page, "api-key-settings");
  await ctx.close();
}

{
  const { ctx, page } = await newPage();
  await login(page, "demo");
  const me = await page.evaluate(async () => (await fetch("/api/auth/me", { credentials: "include" })).json());
  const userId = me.id || me.user?.id || me.profile?.id || null;
  // The key is stored per account: `nodi-gemini-api-key:<userId>`.
  await page.evaluate(
    ([id, key]) => localStorage.setItem(`nodi-gemini-api-key:${id}`, key),
    [userId, DUMMY_KEY],
  );
  await mockAi(page, userId);

  await page.goto(`${BASE}/home`);
  await page.getByText(MOCK_SUGGESTIONS[0]).waitFor({ timeout: 15000 });
  await page.getByPlaceholder("총괄 AI에게 물어보기").fill("미분 공부를 이어서 하고 싶어");
  await page.getByPlaceholder("총괄 AI에게 물어보기").press("Enter");
  await page.getByRole("button", { name: /적분 입문 대화 만들기/ }).waitFor({ timeout: 15000 });
  await settle(page);
  // The streamed reply scrolls the page; bring the greeting back into view.
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    for (const el of document.querySelectorAll("*")) if (el.scrollTop > 0 && !el.closest("[data-overseer], textarea")) el.scrollTop = 0;
  });
  await page.waitForTimeout(300);
  await shot(page, "home");
  await ctx.close();
}

// Conversation trees and concepts come from seeded data (no key, no AI call).
{
  const { ctx, page } = await newPage();
  await login(page, "demo");
  await page.goto(`${BASE}/space/personal`);
  await page.getByText("미분의 기초").first().click();
  await page.locator("svg circle").first().waitFor({ timeout: 15000 });
  await settle(page, 2500);
  await shot(page, "conversation-tree");

  await page.goto(`${BASE}/space/personal`);
  await page.getByText("광합성과 세포 호흡").first().click();
  await page.locator("svg circle").first().waitFor({ timeout: 15000 });
  await settle(page, 2500);
  await shot(page, "conversation-tree-biology");

  await page.goto(`${BASE}/concepts`);
  await settle(page, 2500);
  await shot(page, "concept-map");
  await ctx.close();
}

// ── Teacher ───────────────────────────────────────────────────────────────
{
  const { ctx, page } = await newPage();
  await login(page, "teacher");
  await settle(page);
  await shot(page, "teacher-classes");
  await page.getByText("2학년 3반 통합과학").first().click();
  await page.waitForURL("**/teacher/*");
  await settle(page);
  await page.getByText("이민준").first().click();
  await settle(page);
  await page.getByText("광합성 속도에 영향을 주는 요인").first().click();
  await settle(page, 2000);
  await shot(page, "teacher-student-thread");
  await page.getByRole("button", { name: /자료실/ }).click();
  await settle(page);
  await shot(page, "teacher-materials");
  await ctx.close();
}

// ── Admin ─────────────────────────────────────────────────────────────────
{
  const { ctx, page } = await newPage();
  await login(page, "admin");
  await settle(page);
  await page.getByRole("button", { name: "런타임 설정", exact: true }).click();
  await settle(page, 2000);
  await shot(page, "admin-settings");
  await page.getByRole("button", { name: "로그", exact: true }).click();
  await settle(page, 2000);
  await shot(page, "admin-logs");
  await ctx.close();
}

await browser.close();
