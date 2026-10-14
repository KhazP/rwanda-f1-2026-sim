export default function Loading() {
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center bg-slate-950 text-white">
      <div className="mb-4 h-12 w-12 animate-spin rounded-full border-4 border-sky-400 border-t-transparent" />
      <h2 className="text-lg font-extrabold tracking-wider uppercase text-sky-400">
        Loading Rwanda International Circuit
      </h2>
      <p className="mt-1 text-xs text-slate-400">
        Initializing Three.js r186 • 5.302 km • 18 Turns • 1,400m Altitude
        Physics
      </p>
    </div>
  );
}
