/* three-scene.js — lightweight stylized low-poly car that reacts to live state.
 *  - headlight cones lit when latest.headlights === "on"
 *  - door panels tinted red when the matching door is "open"
 *  - translucent blue glow pulses when latest.charging_status === "charging"
 * Kept to a few hundred triangles so a phone GPU stays cool. */
import * as THREE from "three";

(function () {
  "use strict";

  var canvas = document.getElementById("car-canvas");
  var fallback = document.getElementById("car-fallback");
  if (!canvas) return;

  var renderer, scene, camera, carGroup;
  var doorMeshes = {};      // door key -> mesh
  var headlightMeshes = []; // cone meshes
  var headlightSpots = [];  // spotlights
  var glowMesh = null;      // charging glow
  var state = { headlights: false, charging: false, doors: {} };

  var BODY_COLOR = 0x8a9199;   // GRAY(M) — matches the car
  var DOOR_CLOSED = 0x7a828c;
  var DOOR_OPEN = 0xe5484d;

  try {
    initScene();
    animate();
  } catch (e) {
    console.error("three-scene init failed", e);
    canvas.hidden = true;
    if (fallback) fallback.hidden = false;
    return;
  }

  function initScene() {
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(5.2, 3.4, 6.2);
    camera.lookAt(0, 0.4, 0);

    // lights
    var ambient = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(ambient);
    var key = new THREE.DirectionalLight(0xffffff, 0.8);
    key.position.set(4, 8, 5);
    scene.add(key);
    var rim = new THREE.DirectionalLight(0x5b8cff, 0.35);
    rim.position.set(-5, 3, -4);
    scene.add(rim);

    carGroup = new THREE.Group();
    scene.add(carGroup);

    buildCar();
    resize();
    window.addEventListener("resize", resize, { passive: true });
  }

  function mat(color, opts) {
    return new THREE.MeshStandardMaterial(Object.assign({
      color: color, roughness: 0.55, metalness: 0.35
    }, opts || {}));
  }

  function buildCar() {
    // lower body
    var body = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.9, 2.0), mat(BODY_COLOR));
    body.position.y = 0.55;
    carGroup.add(body);

    // cabin / greenhouse
    var cabin = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.8, 1.7), mat(0x2b2f36, { metalness: 0.2 }));
    cabin.position.set(-0.15, 1.35, 0);
    carGroup.add(cabin);

    // windshield hint (front slope) — small wedge box
    var hood = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.5, 1.9), mat(BODY_COLOR));
    hood.position.set(1.55, 0.85, 0);
    carGroup.add(hood);

    // door panels (thin boxes on each side) — recoloured on open state
    var doorGeo = new THREE.BoxGeometry(1.0, 0.7, 0.06);
    var doorConf = [
      { key: "front_left", x: 0.55, z: 1.02 },
      { key: "rear_left", x: -0.65, z: 1.02 },
      { key: "front_right", x: 0.55, z: -1.02 },
      { key: "rear_right", x: -0.65, z: -1.02 }
    ];
    doorConf.forEach(function (d) {
      var m = new THREE.Mesh(doorGeo, mat(DOOR_CLOSED));
      m.position.set(d.x, 0.65, d.z);
      carGroup.add(m);
      doorMeshes[d.key] = m;
    });
    // hood + trunk lids reuse door highlighting
    var hoodLid = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.08, 1.7), mat(DOOR_CLOSED));
    hoodLid.position.set(1.55, 1.12, 0);
    carGroup.add(hoodLid);
    doorMeshes["hood"] = hoodLid;
    var trunkLid = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 1.7), mat(DOOR_CLOSED));
    trunkLid.position.set(-2.0, 0.7, 0);
    carGroup.add(trunkLid);
    doorMeshes["trunk"] = trunkLid;

    // wheels
    var wheelGeo = new THREE.CylinderGeometry(0.45, 0.45, 0.32, 16);
    var wheelMat = mat(0x111317, { metalness: 0.1, roughness: 0.8 });
    [[1.35, 1.05], [1.35, -1.05], [-1.35, 1.05], [-1.35, -1.05]].forEach(function (p) {
      var w = new THREE.Mesh(wheelGeo, wheelMat);
      w.rotation.x = Math.PI / 2;
      w.position.set(p[0], 0.32, p[1]);
      carGroup.add(w);
    });

    // headlight cones (point forward from the nose)
    var coneGeo = new THREE.ConeGeometry(0.55, 1.6, 20, 1, true);
    [0.6, -0.6].forEach(function (z) {
      var lightMat = new THREE.MeshBasicMaterial({
        color: 0xfff3c0, transparent: true, opacity: 0.0, side: THREE.DoubleSide,
        depthWrite: false
      });
      var cone = new THREE.Mesh(coneGeo, lightMat);
      cone.rotation.z = -Math.PI / 2;      // point +X (front of car)
      cone.position.set(3.0, 0.7, z);
      carGroup.add(cone);
      headlightMeshes.push(cone);

      var spot = new THREE.SpotLight(0xfff3c0, 0, 8, Math.PI / 7, 0.4, 1.2);
      spot.position.set(2.2, 0.7, z);
      spot.target.position.set(6, 0.3, z);
      carGroup.add(spot);
      carGroup.add(spot.target);
      headlightSpots.push(spot);
    });

    // charging glow — translucent sphere around the car
    var glowGeo = new THREE.SphereGeometry(3.4, 24, 16);
    var glowMat = new THREE.MeshBasicMaterial({
      color: 0x3b82f6, transparent: true, opacity: 0.0,
      side: THREE.BackSide, depthWrite: false
    });
    glowMesh = new THREE.Mesh(glowGeo, glowMat);
    glowMesh.position.y = 0.7;
    carGroup.add(glowMesh);
  }

  function resize() {
    var w = canvas.clientWidth || canvas.parentElement.clientWidth || 320;
    var h = canvas.clientHeight || 220;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  var t0 = performance.now();
  function animate() {
    requestAnimationFrame(animate);
    var t = (performance.now() - t0) / 1000;

    // slow idle turntable
    carGroup.rotation.y = Math.sin(t * 0.25) * 0.5;

    // headlight intensity
    var hl = state.headlights ? 1 : 0;
    headlightMeshes.forEach(function (m) {
      m.material.opacity += (hl * 0.35 - m.material.opacity) * 0.15;
    });
    headlightSpots.forEach(function (s) {
      s.intensity += (hl * 2.2 - s.intensity) * 0.15;
    });

    // charging pulse
    var target = state.charging ? (0.10 + 0.06 * (0.5 + 0.5 * Math.sin(t * 2.2))) : 0;
    if (glowMesh) glowMesh.material.opacity += (target - glowMesh.material.opacity) * 0.12;

    renderer.render(scene, camera);
  }

  function applyState(data) {
    if (!data || !data.latest) return;
    var l = data.latest;
    state.headlights = (l.headlights === "on" || l.headlights === true);
    state.charging = (l.charging_status === "charging");
    var doors = l.doors || {};
    Object.keys(doorMeshes).forEach(function (key) {
      var open = doors[key] === "open" || doors[key] === true;
      var m = doorMeshes[key];
      var c = new THREE.Color(open ? DOOR_OPEN : DOOR_CLOSED);
      m.material.color.copy(c);
      m.material.emissive = new THREE.Color(open ? 0x3a0000 : 0x000000);
    });
  }

  window.PHEV.onData(applyState);
})();
