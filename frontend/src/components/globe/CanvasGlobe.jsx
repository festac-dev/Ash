import { useEffect, useMemo, useRef } from "react";

/** Project the same network into a lightweight sphere when a GPU context is unavailable. */
export default function CanvasGlobe({
  network,
  light,
  reduced,
  rotating,
  visible,
  command,
  onReady,
  onSelect,
  onHover,
}) {
  const canvas = useRef();
  const rotation = useRef(0);
  const dragging = useRef(null);
  const frame = useRef(0);
  const moved = useRef(false);
  const draw = useRef(() => {});
  const points = useMemo(
    () =>
      Array.from({ length: 1000 }, (_, i) => {
        const y = 1 - (2 * (i + 0.5)) / 1000;
        const angle = i * Math.PI * (3 - Math.sqrt(5));
        const r = Math.sqrt(1 - y * y);
        return [Math.cos(angle) * r, y, Math.sin(angle) * r];
      }),
    [],
  );
  useEffect(() => {
    if (command.action === "left") rotation.current -= 0.35;
    if (command.action === "right") rotation.current += 0.35;
    if (command.action === "reset") rotation.current = 0;
    draw.current();
  }, [command]);
  useEffect(() => {
    const element = canvas.current;
    const context = element.getContext("2d");
    if (!context) return;
    let width = 1,
      height = 1,
      last = 0,
      frames = 0,
      elapsed = 0;
    let projected = [];
    const project = ([x, y, z]) => {
      const c = Math.cos(rotation.current),
        s = Math.sin(rotation.current);
      const rotatedX = x * c + z * s,
        depth = z * c - x * s;
      const radius = Math.min(width, height) * 0.34;
      return [width / 2 + rotatedX * radius, height / 2 + y * radius, depth];
    };
    draw.current = () => {
      context.clearRect(0, 0, width, height);
      context.fillStyle = light ? "#596471" : "#ccd3dd";
      for (const point of points) {
        const [x, y, z] = project(point);
        context.globalAlpha = 0.2 + (0.7 * (z + 1)) / 2;
        context.beginPath();
        context.arc(x, y, z > 0 ? 1.4 : 0.8, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 0.25;
      context.strokeStyle = light ? "#596471" : "#ccd3dd";
      for (const tilt of [-0.4, 0.5]) {
        context.beginPath();
        context.ellipse(
          width / 2,
          height / 2,
          Math.min(width, height) * 0.41,
          Math.min(width, height) * 0.14,
          tilt,
          0,
          Math.PI * 2,
        );
        context.closePath();
        context.stroke();
      }
      projected = network.nodes
        .slice(0, 64)
        .map((node) => ({ node, position: project(node.position.map((value) => value / 1.83)) }));
      const byId = new Map(projected.map((item) => [item.node.id, item.position]));
      for (const edge of network.edges) {
        const a = byId.get(edge.from),
          b = byId.get(edge.to);
        if (!a || !b) continue;
        context.beginPath();
        context.moveTo(a[0], a[1]);
        context.lineTo(b[0], b[1]);
        context.stroke();
      }
      context.globalAlpha = 1;
      for (const {
        position: [x, y, z],
      } of projected) {
        if (z < -0.15) continue;
        context.beginPath();
        context.arc(x, y, 3.4, 0, Math.PI * 2);
        context.fill();
      }
      element.dataset.rotation = rotation.current.toFixed(3);
      element.dataset.drawCalls = String(points.length + projected.length + network.edges.length + 2);
      element.dataset.pixelRatio = String(Math.min(devicePixelRatio || 1, 1.5));
    };
    const resize = () => {
      const rect = element.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      const dpr = Math.min(devicePixelRatio || 1, 1.5);
      element.width = Math.round(width * dpr);
      element.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw.current();
    };
    const tick = (time) => {
      if (!visible) return;
      const dt = last ? (time - last) / 1000 : 0;
      last = time;
      if (!dragging.current) rotation.current += Math.min(dt, 0.05) * 0.055;
      draw.current();
      frames++;
      elapsed += dt;
      if (elapsed >= 2) {
        element.dataset.fps = (frames / elapsed).toFixed(1);
        elapsed = 0;
        frames = 0;
      }
      frame.current = requestAnimationFrame(tick);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    const move = (event) => {
      const rect = element.getBoundingClientRect();
      if (dragging.current) {
        const dx = event.clientX - dragging.current.x;
        if (Math.abs(dx) > 3) dragging.current.moved = true;
        moved.current = true;
        rotation.current += dx * 0.006;
        dragging.current.x = event.clientX;
        draw.current();
      } else {
        const found = projected.find(
          (item) =>
            item.position[2] > -0.15 &&
            Math.hypot(item.position[0] - event.clientX + rect.left, item.position[1] - event.clientY + rect.top) < 12,
        );
        onHover(found?.node ?? null);
      }
    };
    const down = (event) => {
      dragging.current = { x: event.clientX, moved: false };
      moved.current = false;
    };
    const up = () => {
      dragging.current = null;
    };
    const click = (event) => {
      if (moved.current) return;
      const rect = element.getBoundingClientRect();
      const found = projected.find(
        (item) =>
          item.position[2] > -0.15 &&
          Math.hypot(item.position[0] - event.clientX + rect.left, item.position[1] - event.clientY + rect.top) < 12,
      );
      if (found) onSelect(found.node);
    };
    element.addEventListener("pointerdown", down);
    element.addEventListener("pointermove", move);
    element.addEventListener("click", click);
    window.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
    if (visible && !reduced && rotating) frame.current = requestAnimationFrame(tick);
    onReady({ particles: points.length, renderer: "Canvas2D" });
    return () => {
      cancelAnimationFrame(frame.current);
      observer.disconnect();
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("click", click);
      window.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
    };
  }, [network, light, reduced, rotating, visible, points, onReady, onSelect, onHover]);
  return <canvas ref={canvas} aria-hidden="true" className="canvas-globe" />;
}
