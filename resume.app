// ── PASTE THIS AT typst.app ──────────────────────

#set page(paper: "a4", margin: (top:0.9cm, bottom:0.9cm, x:1.2cm), fill: rgb("FAF7F2"))
#set text(font: "Linux Libertine", size: 9.5pt, fill: rgb("1A1A1A"))
#set list(indent: 6pt)

#show heading.where(level: 1): it => text(size: 26pt, weight: "bold")[#it.body]
#show heading.where(level: 2): it => {
  v(6pt)
  text(size: 8.5pt, weight: "bold", fill: rgb("2C6E6A"), tracking: 1.5pt)[#upper(it.body)]
  v(1pt)
  line(length: 100%, stroke: 0.5pt + rgb("2C6E6A"))
  v(3pt)
}

// reusable skill pill
#let skill(s) = box(fill: rgb("E8F4F3"), inset: (x:8pt,y:3pt), radius: 20pt,
  text(fill: rgb("2C6E6A"), size: 9pt, s))
#let skill-row(category, items) = {
  grid(columns: (110pt, 1fr), gutter: 4pt,
    text(size: 8.5pt, weight: "bold", fill: rgb("2C6E6A"))[#category],
    text(size: 8.5pt, fill: rgb("333333"))[#items])
}

// reusable job entry
#let job(title, company, date, body) = {
  grid(columns: (1fr, auto), [*#title* — #text(fill: rgb("555"))[#company]],
    text(fill: rgb("999"), size: 9pt, date))
  v(2pt); body; v(5pt)
}

#let edu(degree, college, date, gpa) = {
  grid(
    columns: (1fr, auto),
    [*#degree* — #text(fill: rgb("555"))[#college] · #text(fill: rgb("2C6E6A"), size: 8.5pt)[GPA: #gpa]],
    text(fill: rgb("999"), size: 9pt)[#date]
  )
  v(4pt)
}

#let project(title, body, url: none) = {
  v(4pt)
  text(size: 9pt, weight: "bold")[#title]
  if url != none {
    h(6pt)
    box(fill: rgb("E8F4F3"), inset: (x:6pt, y:2pt), radius: 20pt,
      link(url, text(fill: rgb("2C6E6A"), size: 8pt, weight: "bold")[Blog ↗]))
  }
  v(1pt)
  body
}
// ── HEADER ───────────────────────────────────────
#grid(columns: (1fr, auto),
  align(left)[
    = Zuhaib Ul Zamann
    #v(2pt)
    #text(fill: rgb("2C6E6A"), size: 9pt, tracking: 1pt)[ML Engineering · Distributed Systems · Agentic AI]
  ],
  align(right+horizon, text(size: 9pt, fill: rgb("777"))[
    zuhaibulzaman.786\@gmail.com \ github.com/zuhaib786 \ Srinagar J\&K, India
  ])
)
#v(6pt)
#line(length: 100%, stroke: 2pt + rgb("2C6E6A"))

// ── EXPERIENCE ───────────────────────────────────
== Experience

#job("Senior Machine Learning Engineer", "Sprinklr", "Jun 2023 – Present")[
//   #project("Cloud Cost Optimization & Telemetry Framework")[
//     - Designed an automation framework for cloud cost telemetry, enabling per-microservice cost allocation across Kubernetes clusters. Achieved >\$100,000/month reduction in infrastructure spend.
//     - Developed intelligent alerting system for proactive detection of abnormal cost spikes.
//     - Built resource reconciliation and automated rollback system, increasing cluster utilization from 50% to 70%+.
//   ]
//   #project("Observability & Distributed Tracing Platform")[
//     - Designed error and time telemetry frameworks with Elasticsearch for distributed microservices.
//     - Saved hundreds of developer hours through automated error detection; adopted across multiple teams.
//   ]
//   #project("Resiliency & Automated Auditing System")[
//     - Engineered a framework to audit microservices, Kubernetes clusters, and repositories for resiliency issues.
//     - Improved platform stability from 95% to 99.999% uptime.
//   ]
//   #project("Agentic Copilots for Marketing & Social Suites", url:"https://engineering.sprinklr.com/building-embedded-ai-agents-that-works-the-sprinklr-copilot-blueprint-bc2505f5c6bd")[
//     - Developed intelligent agentic copilots leveraging LLM capabilities for context-aware assistance.
//     - Built scalable backend services for real-time AI-powered decision-making across product features.
//   ]
// ]
  #project("Agentic Copilots for Marketing & Social Suites", url:"https://engineering.sprinklr.com/building-embedded-ai-agents-that-works-the-sprinklr-copilot-blueprint-bc2505f5c6bd")[
    - Shipped production copilots that answer user queries about their social and marketing data, replacing manual dashboard navigation with natural language — achieving *90% satisfactory resolution* across *3K queries/month*.
    - Built as a shared platform so each product team could plug in their own data context instead of rebuilding from scratch, enabling rapid adoption across the organization.
  ]
  #project("Cloud Cost Optimization & Telemetry Framework")[
    - Architected cost telemetry across 1,000+ microservices and 500-node clusters enabling precise per-microservice attribution, driving *\$100K+/month in infrastructure savings* over 2 years.
    - Automated resource reconciliation and intelligent rollback, cutting per-quarter spend by \$20K–\$30K and lifting cluster utilization from *50% to 70%+*.
    - Built proactive alerting for abnormal cost spikes across a large-scale multi-cloud environment, preventing undetected runaway spend.
  ]
  #project("Observability & Distributed Tracing Platform")[
    - Designed error and latency telemetry for distributed microservices using Elasticsearch, compressing RCA time from *30–40 minutes to under 6 minutes* and eliminating manual log triage.
    - Framework voluntarily adopted by multiple independent engineering teams without mandate after eliminating pod-retry cycles entirely.
  ]
  #project("Resiliency & Automated Auditing System")[
    - Enforcement-by-design auditing across 100–200 microservices — mandating HA minimums, replica bounds, DNS-only discovery, and proxy-mediated DB connections — lifted platform uptime from *95% to 99.999%*.
    - Rules enforced at deploy time, not detected after the fact, *eliminating entire classes of mis-configuration* at the source.
  ]

]

// ── SKILLS ───────────────────────────────────────

== Technical Skills

#skill-row("Languages", "Python, Java, C/C++")
#skill-row("Cloud & Infrastructure", "AWS, GCP, Kubernetes, Docker, Linkerd (Service Mesh), Keda, Terraform")
#skill-row("Databases & Tools", "Elasticsearch, Redis, MongoDB, S3, CI/CD Pipelines")
#skill-row("Core Competencies", "Distributed Systems, Microservices Architecture, Cloud Cost Optimization, System Design")

// ── EDUCATION ────────────────────────────────────
== Education

#edu("M.Tech ", "Indian Institute of Technology Delhi", "2022 – 2023", "10.0/10.0")
#edu("B.Tech", "Indian Institute of Technology Delhi", "2018 – 2022", "9.414/10.0")

== Awards & Achievements

- *Departmental Rank 2* — Ranked second in my batch; perfect GPA of 10.0/10.0 during M.Tech.
- *Best Thesis Award* — Recognized for M.Tech thesis on Discontinuity Identification using Graph Neural Networks.
- *IIT Delhi Merit Prize* — Awarded for six consecutive semesters (Top 7% performers in department).
#v(100pt)

// == Personal Projects

// #project("LLM Inference — Visual Learning Repository", url: "https://github.com/zuhaib786/llm-inf-stack")[
//   - Built an interactive visual learning wrepository covering the full LLM inference stack — quantization, paged attention, speculative decoding, dynamic batching, prefill-decode disaggregation, tensor/expert/model parallelism, and attention optimizations (FlashAttention, sliding window) — using Manim and Marimo for deep technical understanding.
//   - Designed for engineers who want to implement, not just use — bridging the gap between research papers and production systems.
// ]
