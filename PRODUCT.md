# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Inferred from the product and project instructions: people learning, teaching, or exploring operating-system CPU scheduling and Windows process monitoring.

## Product Purpose

The Multi-Core CPU Scheduling Simulator lets people configure a process workload, run classic scheduling algorithms across multiple cores, inspect an animated execution timeline and timing metrics, compare algorithms, and optionally connect a Windows C11 agent for live hardware and process data.

## Positioning

The browser scheduling model and downloadable Windows C11 implementation bring algorithm-level simulation, multi-core timelines, and optional live Windows monitoring into one learning tool.

## Operating Context

The browser simulator works without credentials or a backend. The optional Windows agent runs locally and can connect to the hosted dashboard with the user's permission. The project includes a MinGW-w64 C11 source package and a local dashboard.

## Capabilities and Constraints

- Scheduling algorithms: FCFS, SJF, SRTF, Priority, and Round Robin.
- The browser simulation supports 1–8 CPU cores; the queue supports up to 64 processes.
- Results include Gantt timelines, replay, per-process timing, core utilization, and cross-algorithm analytics.
- The Windows agent provides live hardware and process monitoring and can launch verified executables.
- No API keys or secrets are required. Actual hardware telemetry is available only after connecting the Windows agent; browser preview readings are illustrative.

## Brand Commitments

The established product name is Multi-Core CPU Scheduling Simulator. The current interface uses the “Signal” graphite, teal, and amber palette and pairs the browser simulator with a Windows C11 implementation.

## Evidence on Hand

The README, React application, scheduler engine, Windows agent client, and downloadable C11 source in this repository are the product source of truth. Browser preview telemetry is sample data, not a claim about a visitor's computer. No customer, benchmark, or commercial claims are established.

## Product Principles

- Keep algorithm configuration, workload editing, and results in one connected simulation flow.
- Make scheduling decisions and timing formulas inspectable.
- Label sample data and preview telemetry clearly.
- Keep live Windows monitoring optional and explain how to connect it.
