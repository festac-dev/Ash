import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { nodeTone, orbitPositions } from "../../lib/network.js";

function spherePoints(count) {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const angle = i * Math.PI * (3 - Math.sqrt(5));
    const r = Math.sqrt(1 - y * y);
    positions.set([Math.cos(angle) * r * 1.8, y * 1.8, Math.sin(angle) * r * 1.8], i * 3);
  }
  return positions;
}
const vertex = `
  uniform float pixelRatio; uniform float size;
  varying float facing; varying float tint;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.);
    facing = .23 + .77 * smoothstep(-.8, .7, normalize(normalMatrix * normalize(position)).z);
    tint = smoothstep(-.2, .85, sin(position.y * 1.8 + position.x));
    gl_PointSize = clamp(size * pixelRatio * (6. / -mv.z), 1., 12.);
    gl_Position = projectionMatrix * mv;
  }`;
const fragment = `
  uniform vec3 mint; uniform vec3 blue;
  varying float facing; varying float tint;
  void main() {
    float d = length(gl_PointCoord - .5);
    if (d > .5) discard;
    float a = smoothstep(.5, .12, d);
    gl_FragColor = vec4(mix(mint, blue, tint * .58), a * facing);
  }`;

function ParticleSphere({ count, light }) {
  const { viewport } = useThree();
  const positions = useMemo(() => spherePoints(count), [count]);
  const lines = useMemo(() => {
    const output = [];
    for (let i = 0; i < count; i += 4) {
      for (const gap of [34, 55]) {
        const j = (i + gap) % count;
        const a = positions.subarray(i * 3, i * 3 + 3);
        const b = positions.subarray(j * 3, j * 3 + 3);
        if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 0.44) output.push(...a, ...b);
      }
    }
    return new Float32Array(output);
  }, [positions, count]);
  const uniforms = useMemo(
    () => ({
      pixelRatio: { value: viewport.dpr },
      size: { value: count > 1600 ? 3.1 : 3.6 },
      mint: { value: new THREE.Color(light ? "#484f57" : "#e0e3e7") },
      blue: { value: new THREE.Color(light ? "#646c78" : "#a0aab9") },
    }),
    [light, viewport.dpr, count],
  );
  return (
    <>
      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <shaderMaterial
          uniforms={uniforms}
          vertexShader={vertex}
          fragmentShader={fragment}
          transparent
          depthWrite={false}
          blending={light ? THREE.NormalBlending : THREE.AdditiveBlending}
        />
      </points>
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[lines, 3]} />
        </bufferGeometry>
        <lineBasicMaterial
          color={light ? "#6c747d" : "#b4bcc7"}
          transparent
          opacity={light ? 0.15 : 0.13}
          depthWrite={false}
        />
      </lineSegments>
    </>
  );
}

function Orbit({ radius, rotation, color, opacity }) {
  const points = useMemo(() => orbitPositions(radius), [radius]);
  return (
    <lineLoop rotation={rotation}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[points, 3]} />
      </bufferGeometry>
      <lineBasicMaterial color={color} transparent opacity={opacity} depthWrite={false} />
    </lineLoop>
  );
}

function NetworkRoutes({ network, light }) {
  const positions = useMemo(() => {
    const nodes = new Map(network.nodes.map((n) => [n.id, n.position]));
    const p = [];
    for (const edge of network.edges) {
      const a = nodes.get(edge.from),
        b = nodes.get(edge.to);
      if (!a || !b) continue;
      const va = new THREE.Vector3(...a),
        vb = new THREE.Vector3(...b);
      let prev = va.clone();
      for (let i = 1; i <= 24; i++) {
        const at = i / 24;
        const next = va
          .clone()
          .lerp(vb, at)
          .normalize()
          .multiplyScalar(1.83 + Math.sin(at * Math.PI) * 0.24);
        p.push(...prev.toArray(), ...next.toArray());
        prev = next;
      }
    }
    return new Float32Array(p);
  }, [network.edges, network.nodes]);
  return (
    <lineSegments>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <lineBasicMaterial color={light ? "#525b67" : "#d7dce2"} transparent opacity={0.5} />
    </lineSegments>
  );
}

function Pulse({ event, nodes, reduced }) {
  const mesh = useRef();
  const start = useMemo(
    () => nodes.find((n) => n.id === event.nodeId)?.position ?? [0, 0, 1.83],
    [event.nodeId, nodes],
  );
  const confirmed = event.type === "transaction.confirmed" || event.type === "verification.passed";
  const warning = event.type.includes("failed");
  useFrame(() => {
    if (!mesh.current) return;
    const t = (Date.now() - event.receivedAt) / 2400;
    mesh.current.visible = t < 1 && !reduced;
    mesh.current.scale.setScalar(1 + Math.min(1, t) * (confirmed ? 5 : 3));
    mesh.current.material.opacity = Math.max(0, 0.6 * (1 - t));
  });
  return (
    <mesh ref={mesh} position={start}>
      <sphereGeometry args={[0.07, 12, 8]} />
      <meshBasicMaterial
        color={warning ? "#efa972" : confirmed ? "#f1f3f5" : "#c6cdd7"}
        transparent
        opacity={0}
        depthWrite={false}
        wireframe={confirmed}
      />
    </mesh>
  );
}

function Communication({ event, network, reduced }) {
  const mesh = useRef();
  const curve = useMemo(() => {
    const edge = network.edges.find((e) => e.to === event.nodeId || e.from === event.nodeId);
    const from = network.nodes.find((n) => n.id === edge?.from);
    const to = network.nodes.find((n) => n.id === edge?.to);
    return from && to ? [new THREE.Vector3(...from.position), new THREE.Vector3(...to.position)] : null;
  }, [network, event.nodeId]);
  const scratch = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    if (!mesh.current) return;
    const t = (Date.now() - event.receivedAt) / 2200;
    mesh.current.visible = Boolean(curve) && t < 1 && !reduced;
    if (curve)
      mesh.current.position.copy(
        scratch
          .copy(curve[0])
          .lerp(curve[1], Math.min(t, 1))
          .normalize()
          .multiplyScalar(1.83 + Math.sin(t * Math.PI) * 0.24),
      );
  });
  return (
    <mesh ref={mesh}>
      <sphereGeometry args={[0.035, 8, 6]} />
      <meshBasicMaterial color="#f1f3f5" />
    </mesh>
  );
}

function Scene({
  network,
  pulses,
  light,
  reduced,
  rotating,
  visible,
  command,
  onHover,
  onSelect,
  onReady,
  onContextLost,
}) {
  const group = useRef();
  const { gl, camera, invalidate, setDpr } = useThree();
  const interaction = useRef({ x: 0, y: 0, mx: 0, my: 0, scroll: 0, down: null, moved: false });
  const performance = useRef({ elapsed: 0, frames: 0, low: 0, adapted: false });
  const [count, setCount] = useState(() =>
    navigator.hardwareConcurrency <= 4 || matchMedia("(max-width: 680px)").matches || navigator.connection?.saveData
      ? 1300
      : 2600,
  );
  useEffect(() => {
    const canvas = gl.domElement;
    const onDown = (e) => {
      interaction.current.down = [e.clientX, e.clientY];
      interaction.current.moved = false;
    };
    const onMove = (e) => {
      const v = interaction.current,
        rect = canvas.getBoundingClientRect();
      if (v.down) {
        const dx = e.clientX - v.down[0],
          dy = e.clientY - v.down[1];
        if (!v.moved && Math.hypot(dx, dy) < 4) return;
        v.x += dx * 0.006;
        v.y = Math.max(-0.5, Math.min(0.5, v.y + dy * 0.004));
        v.moved = true;
        v.down = [e.clientX, e.clientY];
      } else {
        v.mx = (e.clientX - rect.left) / rect.width - 0.5;
        v.my = (e.clientY - rect.top) / rect.height - 0.5;
      }
      invalidate();
    };
    const onUp = () => {
      interaction.current.down = null;
    };
    const onScroll = () => {
      interaction.current.scroll = Math.min(window.scrollY / window.innerHeight, 1);
      invalidate();
    };
    const lost = (e) => {
      e.preventDefault();
      onContextLost();
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    window.addEventListener("scroll", onScroll, { passive: true });
    canvas.addEventListener("webglcontextlost", lost);
    onReady({ particles: count, renderer: "WebGL", drawCalls: gl.info.render.calls });
    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      window.removeEventListener("scroll", onScroll);
      canvas.removeEventListener("webglcontextlost", lost);
    };
  }, [gl, invalidate, count, onReady, onContextLost]);
  useEffect(() => {
    const v = interaction.current;
    if (command.action === "left") v.x -= 0.35;
    if (command.action === "right") v.x += 0.35;
    if (command.action === "reset") {
      v.x = 0;
      v.y = 0;
      group.current.rotation.set(0.08, 0, -0.08);
    }
    invalidate();
  }, [command, invalidate]);
  useEffect(() => {
    invalidate();
  }, [network, pulses, reduced, rotating, visible, light, invalidate]);
  useFrame((_, delta) => {
    if (!visible) return;
    const v = interaction.current;
    const dt = Math.min(delta, 0.05);
    if (!reduced && rotating && !v.down) v.x += dt * 0.055;
    const ease = reduced ? 1 : 1 - Math.exp(-dt * 10);
    group.current.rotation.y += (v.x + (reduced ? 0 : v.mx * 0.1) - group.current.rotation.y) * ease;
    group.current.rotation.x += (0.08 + v.y + (reduced ? 0 : v.my * 0.06) - group.current.rotation.x) * ease;
    camera.position.z += ((reduced ? 6.5 : 6.5 - v.scroll * 0.3) - camera.position.z) * ease;
    if (
      !reduced &&
      !rotating &&
      (Math.abs(v.x + v.mx * 0.1 - group.current.rotation.y) > 0.0002 ||
        Math.abs(0.08 + v.y + v.my * 0.06 - group.current.rotation.x) > 0.0002 ||
        Math.abs(6.5 - v.scroll * 0.3 - camera.position.z) > 0.0002)
    )
      invalidate();
    gl.domElement.dataset.rotation = group.current.rotation.y.toFixed(3);
    const p = performance.current;
    if (!reduced && rotating) {
      p.elapsed += delta;
      p.frames++;
      if (p.elapsed > 3) {
        const fps = p.frames / p.elapsed;
        gl.domElement.dataset.fps = fps.toFixed(1);
        gl.domElement.dataset.drawCalls = String(gl.info.render.calls);
        gl.domElement.dataset.pixelRatio = String(gl.getPixelRatio());
        if (fps < 40 && !p.adapted) {
          setDpr(1);
          setCount(1300);
          p.adapted = true;
        }
        p.elapsed = 0;
        p.frames = 0;
      }
    }
  });
  return (
    <group ref={group} rotation={[0.08, 0, -0.08]}>
      <ParticleSphere count={count} light={light} />
      <Orbit radius={2.05} rotation={[0.55, 0.3, -0.2]} color={light ? "#747b82" : "#b4bcc4"} opacity={0.24} />
      <Orbit radius={2.24} rotation={[-0.38, -0.3, 0.55]} color={light ? "#838b95" : "#939eab"} opacity={0.22} />
      <Orbit radius={2.35} rotation={[0.08, 0.3, -0.55]} color={light ? "#747b82" : "#c3c8cf"} opacity={0.1} />
      <NetworkRoutes network={network} light={light} />
      {network.nodes.slice(0, 64).map((node) => (
        <mesh
          key={node.id}
          position={node.position}
          onPointerOver={(e) => {
            e.stopPropagation();
            onHover(node);
          }}
          onPointerOut={() => onHover(null)}
          onClick={(e) => {
            e.stopPropagation();
            if (!interaction.current.moved) onSelect(node);
          }}
        >
          <sphereGeometry args={[0.038, 10, 8]} />
          <meshBasicMaterial
            color={
              nodeTone(node) === "warning"
                ? "#df9957"
                : nodeTone(node) === "verified"
                  ? "#f0f2f5"
                  : light
                    ? "#414a56"
                    : "#edf0f3"
            }
          />
        </mesh>
      ))}
      {!reduced &&
        pulses.map((event) => (
          <group key={event.id}>
            <Pulse event={event} nodes={network.nodes} reduced={reduced} />
            {["agent.communication", "agent.assigned", "transaction.confirmed"].includes(event.type) && (
              <Communication event={event} network={network} reduced={reduced} />
            )}
          </group>
        ))}
    </group>
  );
}

export default function GlobeScene(props) {
  return (
    <Canvas
      aria-hidden="true"
      tabIndex={-1}
      camera={{ position: [0, 0, 6.5], fov: 44 }}
      dpr={[1, 1.5]}
      gl={{ alpha: true, antialias: true, powerPreference: "low-power" }}
      frameloop={props.visible && !props.reduced && (props.rotating || props.pulses.length > 0) ? "always" : "demand"}
      raycaster={{ params: { Points: { threshold: 0.03 } } }}
    >
      <Scene {...props} />
    </Canvas>
  );
}
