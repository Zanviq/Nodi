# 🌱 nodi

**질문과 답변을 노드로 묶어 대화를 트리로 보여주는 AI 채팅 서비스입니다.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Next.js](https://img.shields.io/badge/Next.js-000000?logo=nextdotjs&logoColor=white)](https://nextjs.org/) [![React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB)](https://react.dev/) [![Python](https://img.shields.io/badge/Python-3776AB?logo=python&logoColor=white)](https://www.python.org/) [![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/) [![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/) [![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

[English](README.md) | **한국어**

[![Powered by Gemini](https://img.shields.io/badge/Powered%20by-Google%20Gemini-4285F4?style=for-the-badge&logo=google&logoColor=white)](https://ai.google.dev)

---

## 💭 Developer's Note

> *"AI와의 대화는 한 줄이 아니라 나무처럼 갈라진다."*

<!-- TODO: 개발 동기 -->

---

## ✨ Features

### 🌳 트리 대화
- 질문 하나와 그 답변이 노드 하나가 되고(`nodes.parent_id`), 세션은 현재 헤드 노드를 기억합니다
- AI에는 이어서 질문하는 노드의 조상 경로만 전달되고, 형제 분기는 빠집니다
- 답변은 SSE로 스트리밍되며, 노드마다 짧은 자동 라벨(최대 10자)과 개념 태그 1~3개가 붙습니다
- 트리는 D3로 위에서 아래로 그려지고, 드래그한 노드 위치는 한 번의 일괄 요청으로 저장됩니다

### 🔗 기억 연결
- 노드를 우클릭 → **기억 연결** → 다른 분기의 노드를 클릭하면 주황색 선으로 연결됩니다
- 메시지를 보낼 때 연결된 노드 중 공통 조상 아래 부분만 참고 맥락으로 추가됩니다(최대 12개 노드, 답변당 400자)

### 🧭 네비게이터 질문
- 한 분기에 개념 태그를 공유하는 노드가 3개 이상 쌓이면, 이어서 할 만한 질문이 점선 노드로 나타납니다
- 클릭하면 질문과 그 질문으로 알 수 있는 내용이 표시되고(노드에 저장된 값, 추가 AI 호출 없음), **질문하기**로 그 분기에서 바로 질문합니다
- 조건과 질문 개수는 런타임 설정으로 바꿀 수 있습니다

### 📄 파일 RAG
- PDF·텍스트·Markdown·이미지 파일을 올리면 pypdf 또는 Gemini OCR(이미지)로 텍스트를 뽑습니다
- 텍스트는 청크로 나눠 `gemini-embedding-001`(768차원)로 임베딩해 pgvector에 저장합니다
- 노드에 연결한 파일은 그 노드의 분기에 적용되며, 상위 5개 청크가 프롬프트에 들어가고 답변 아래에 출처로 표시됩니다
- 연결하지 않은 파일이 질문과 충분히 가까우면(코사인 거리 기준) 연결을 제안합니다

### 🏠 홈과 개념
- 홈에는 많이 쓴 개념, 최근 대화, AI 추천 질문이 나옵니다
- 총괄 AI는 읽기 전용 스킬로 내 공간·최근 세션·개념을 조회하고, 세션을 열거나 새로 만드는 버튼과 함께 답합니다
- 개념 페이지는 전체 태그를 사용 빈도별로 묶어 보여줍니다

### 👩‍🏫 학급
- 교사는 6자리 참여 코드로 학급을 만들고, 학생은 온보딩이나 프로필에서 코드를 입력해 참여합니다
- 교사는 학생의 학급 대화를 읽기 전용으로 보고, 학급 구성원 모두가 RAG에 쓰는 수업 자료를 올립니다

### 🛠️ 운영 콘솔
- 사용자 역할 변경(학생 / 교사 / 관리자)
- DB에 저장되는 런타임 설정 편집(모델 이름, 네비게이터·RAG 파라미터)
- 사용자별 토큰 사용량(총괄 AI 스킬 단계 기준), 프롬프트·답변·사용된 맥락이 담긴 채팅 턴 로그(5초마다 갱신)

### 👤 계정과 권한
- 아이디·비밀번호로 가입/로그인(bcrypt 해시, httpOnly 쿠키의 JWT)
- 개인·학급 데이터 접근 규칙은 모든 쿼리에서 백엔드 접근 계층이 검사합니다

---

## 🚀 Getting Started

### Prerequisites
- [Docker](https://docs.docker.com/get-docker/)와 Docker Compose
- (선택, AI 기능용) [Google Gemini API 키](https://aistudio.google.com/apikey)

### 실행

```bash
git clone https://github.com/Zanviq/Nodi.git
cd Nodi
cp .env.example .env
docker compose up
```

http://localhost:3000 에 접속합니다(포트가 사용 중이면 `.env`의 `WEB_PORT`를 바꾸세요).

처음 실행하면 `migrate` 서비스가 DB 스키마를 적용하고 데모 데이터(계정, 대화, 학급, 파일)를 넣습니다.

### 데모 계정

| 아이디 | 비밀번호 | 역할 |
|--------|----------|------|
| `demo` | `demo1234` | 학생 |
| `teacher` | `demo1234` | 교사 |
| `admin` | `demo1234` | 관리자 |

### Gemini API 키
키가 없어도 로그인해서 대화 트리, 개념, 자료, 교사 콘솔, 운영 콘솔 등 모든 화면을 볼 수 있습니다. 채팅 전송, 총괄 AI, 추천 질문, 네비게이터 질문, 파일 색인은 키를 넣어야 동작합니다.

1. 사이드바의 열쇠 아이콘(또는 계정 메뉴의 **Gemini API 키**)을 누릅니다
2. 키를 붙여 넣고 **저장**을 누릅니다
3. 키는 브라우저 localStorage에만 저장되고, AI 요청 때 `X-Gemini-Key` 헤더로 백엔드에 전달됩니다. 서버는 키를 저장하거나 로그에 남기지 않습니다

---

## 🛠️ Tech Stack

| Category | Technology |
|----------|-----------|
| **Frontend** | Next.js 16, React 19, TypeScript |
| **State / Data** | TanStack Query 5, Zustand |
| **Visualization** | D3.js 7 |
| **Styling** | Tailwind CSS 4 |
| **Markdown** | react-markdown |
| **Backend** | Python 3.12, FastAPI, asyncpg |
| **AI** | Google Gemini API (`google-genai`: 채팅, 라벨, 태그, OCR, 임베딩) |
| **Database** | PostgreSQL 16, pgvector, dbmate (마이그레이션) |
| **Auth** | bcrypt, python-jose (httpOnly 쿠키의 JWT) |
| **Files** | pypdf, 로컬 볼륨 저장 |
| **Infra** | Docker Compose |
| **Screenshots** | Playwright |

---

## 📁 Project Structure

```
Nodi/
├── 📂 frontend/
│   ├── 📂 src/
│   │   ├── 📂 app/                    # 페이지: 로그인, 홈, 공간, 개념, 프로필, 교사, 운영
│   │   ├── 📂 components/
│   │   │   ├── 📂 workspace/          # 채팅 패널, D3 세션 그래프, 자료 패널, 네비게이터 팝업
│   │   │   ├── 📂 home/               # 개념 버블, 총괄 AI 채팅
│   │   │   ├── 📂 teacher/            # 학급 목록, 학생 대화, 수업 자료
│   │   │   ├── 📂 admin/              # 권한, 런타임 설정, 사용량, 로그
│   │   │   └── 📂 settings/           # Gemini API 키 입력 창과 안내
│   │   ├── 📂 lib/
│   │   │   ├── api.ts                 # /api 호출 래퍼, SSE 파싱
│   │   │   ├── geminiKey.ts           # localStorage의 Gemini 키
│   │   │   └── useWorkspaceChat.ts    # 채팅 스트리밍과 낙관적 노드
│   │   ├── 📂 store/                  # Zustand 스토어(워크스페이스, 환경설정)
│   │   └── proxy.ts                   # 세션 쿠키가 없으면 /login으로 이동
│   ├── next.config.ts                 # /api/* 요청을 백엔드로 전달
│   └── Dockerfile
├── 📂 backend/
│   ├── 📂 app/
│   │   ├── 📂 db/                     # asyncpg 풀, 쿼리 빌더, 접근 규칙
│   │   ├── 📂 auth/                   # 비밀번호 해시, 세션 쿠키, 현재 사용자
│   │   ├── 📂 routers/                # auth, sessions, chat, nodes, files, tags, home, overseer, teacher, admin
│   │   ├── 📂 services/               # Gemini 호출, 태깅, 기억 연결, 네비게이터, RAG, 파일 처리
│   │   ├── 📂 ai/                     # 총괄 AI용 스킬 실행기와 읽기 전용 스킬
│   │   ├── ai_key.py                  # X-Gemini-Key 처리와 로그 가림
│   │   └── main.py                    # FastAPI 진입점
│   └── Dockerfile
├── 📂 db/
│   ├── 📂 migrations/                 # 스키마(dbmate)
│   └── 📂 seed/                       # 데모 데이터와 샘플 파일
├── 📂 scripts/
│   └── 📂 capture-screenshots/        # README 스크린샷용 Playwright 스크립트
├── 📂 image/                          # 스크린샷
├── docker-compose.yml                 # db, migrate, backend, frontend
└── .env.example
```

---

## 💡 How to Use

1. **로그인**: 데모 계정을 쓰거나 회원가입 탭에서 계정을 만듭니다
2. **키 입력**: 사이드바 열쇠 아이콘에서 Gemini API 키를 넣으면 AI 기능이 켜집니다
3. **대화 시작**: **개인** 공간에서 **새 대화**를 누르고 질문을 보냅니다
4. **분기**: 트리에서 이전 노드를 선택하고 새 질문을 보내면 그 노드에서 새 분기가 생깁니다
5. **기억 연결**: 노드 우클릭 → **기억 연결** → 대상 노드 클릭. 다른 분기 내용이 참고 맥락으로 쓰입니다
6. **자료 활용**: **자료** 패널에서 파일을 올리고 **그래프에 추가**를 누른 뒤, 파일 노드를 우클릭하고 대화 노드를 클릭해 연결합니다
7. **학급 참여**: 프로필에서 참여 코드를 입력하면 학급 공간에 학급 대화가 생깁니다
8. **수업 관리**: `teacher`로 로그인해 학생의 학급 대화를 보고 수업 자료를 올립니다

---

## 👥 Team

<!-- TODO: 팀원 정보 (이름 | 역할) -->

| 이름 | 역할 |
|------|------|
|  |  |

---

## 🎨 Screenshots

<p align="center">
  <img src="image/conversation-tree.png" alt="대화 트리 워크스페이스" width="100%">
</p>

<table>
  <tr>
    <td align="center"><img src="image/landing-login.png" alt="로그인"><br><sub>로그인</sub></td>
    <td align="center"><img src="image/home.png" alt="홈"><br><sub>홈과 총괄 AI</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="image/conversation-tree-biology.png" alt="분기 대화"><br><sub>분기 대화</sub></td>
    <td align="center"><img src="image/concept-map.png" alt="개념"><br><sub>개념</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="image/api-key-settings.png" alt="Gemini API 키"><br><sub>Gemini API 키 설정</sub></td>
    <td align="center"><img src="image/teacher-student-thread.png" alt="교사 콘솔"><br><sub>교사 콘솔: 학생 대화</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="image/teacher-materials.png" alt="수업 자료"><br><sub>수업 자료</sub></td>
    <td align="center"><img src="image/teacher-classes.png" alt="학급"><br><sub>교사 콘솔: 학급</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="image/admin-settings.png" alt="런타임 설정"><br><sub>운영: 런타임 설정</sub></td>
    <td align="center"><img src="image/admin-logs.png" alt="로그"><br><sub>운영: 채팅 로그</sub></td>
  </tr>
</table>

---

## 📝 License

MIT License. 자세한 내용은 [LICENSE](LICENSE)를 참고하세요.

| 👤 Developer | ✉️ Email |
|:---:|:---:|
| Zanviq | zanviq.dev@gmail.com |
