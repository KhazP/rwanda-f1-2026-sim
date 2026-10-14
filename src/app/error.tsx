"use client";

import React from "react";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center bg-slate-950 p-6 text-center text-white">
      <h2 className="text-xl font-bold text-red-400">
        Telemetry / WebGL Initialization Error
      </h2>
      <p className="mt-2 max-w-md text-xs text-slate-400">{error.message}</p>
      <button
        type="button"
        onClick={reset}
        className="mt-4 rounded-xl bg-sky-500 px-4 py-2 text-xs font-bold text-slate-950 hover:bg-sky-400 cursor-pointer"
      >
        Restart Simulator
      </button>
    </div>
  );
}
