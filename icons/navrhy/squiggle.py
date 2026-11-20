import math
R = ['#ff6b70', '#ffa14d', '#ffd35a', '#6fcf8d', '#55b8ef', '#8089f0', '#c183ec']
INK = '#1d2740'
head = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">'

def smooth(pts):
    d = f"M {pts[0][0]:.1f} {pts[0][1]:.1f}"
    for i in range(len(pts) - 1):
        p0 = pts[max(i - 1, 0)]; p1 = pts[i]; p2 = pts[i + 1]; p3 = pts[min(i + 2, len(pts) - 1)]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        d += f" C {c1[0]:.1f} {c1[1]:.1f}, {c2[0]:.1f} {c2[1]:.1f}, {p2[0]:.1f} {p2[1]:.1f}"
    return d

def loops(n=2, lam=3.2, tilt=-14, fit=126):
    # protáhlá trochoida = ručně kreslené smyčky; stejné měřítko v obou osách
    t0, t1 = -0.4 * math.pi, (2 * n - 0.6) * math.pi
    raw = [(t - lam * math.sin(t), -(1 - lam * math.cos(t))) for t in (t0 + (t1 - t0) * i / 400 for i in range(401))]
    a = math.radians(tilt)
    raw = [(x * math.cos(a) - y * math.sin(a), x * math.sin(a) + y * math.cos(a)) for x, y in raw]
    bx = (max(q[0] for q in raw) + min(q[0] for q in raw)) / 2
    by = (max(q[1] for q in raw) + min(q[1] for q in raw)) / 2
    sc = fit / max(math.hypot(x - bx, y - by) for x, y in raw)
    return smooth([(256 + (x - bx) * sc, 256 + (y - by) * sc) for x, y in raw])

def ring(n=7, radius=192, r=30, hollow=0):
    out = []
    for i in range(n):
        ang = -math.pi / 2 + i * 2 * math.pi / n
        x, y = 256 + radius * math.cos(ang), 256 + radius * math.sin(ang)
        col = R[i % 7]
        if i >= n - hollow:
            out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r - 5}" fill="none" stroke="{col}" stroke-width="11"/>')
        else:
            out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r}" fill="{col}"/>')
    return out

def icon(name, stroke, dots):
    svg = [head, f'<rect width="512" height="512" rx="112" fill="{INK}"/>', *dots,
           f'<path d="{loops()}" fill="none" stroke="{stroke}" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/>',
           '</svg>']
    open(name + '.svg', 'w').write('\n'.join(svg))

icon('G-bily', '#ffffff', ring())
icon('H-ruzovy', '#ff5c93', ring())
icon('I-postup', '#ffffff', ring(n=9, radius=194, r=27, hollow=2))
print('ok')
