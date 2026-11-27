// 3D sign text from the grid strokes: one thin box per line segment, in one InstancedMesh (like the title word).
function textMesh(text, size, color) {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color }), 999)
  const scale = size / 8
  let n = 0
  ;[...text.toUpperCase()].forEach((ch, c) => {
    for (const stroke of font[ch] || []) {
      const points = stroke.split(' ').map((point) => point.split(',').map(Number))
      points.forEach(([x1, y1], i) => {
        const [x0, y0] = points[i ? i - 1 : 0]
        const a = new THREE.Vector3((c * 6 + x0) * scale, -y0 * scale, 0)
        const b = new THREE.Vector3((c * 6 + x1) * scale, -y1 * scale, 0)
        const box = new THREE.Object3D()
        box.position.lerpVectors(a, b, 0.5)
        box.lookAt(b)
        box.scale.set(scale, scale, a.distanceTo(b) + scale)
        box.updateMatrix()
        mesh.setMatrixAt(n++, box.matrix)
      })
    }
  })
  mesh.count = n
  return mesh
}
