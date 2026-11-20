const TOOL_NAME = "Split";
const MIN_PIECE_SIZE = 4;
const MIN_CUT_LENGTH = 4;
const MIN_CROP_SPAN = 0.02;
const SPLIT_GAP = 8;
const CUT_LINE_COLOR = "#ef4444";
const CUTTER_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><path d="M8 5 L5 8 L18 21 Q20 22 21 21 Q22 20 21 18 Z" fill="#f59e0b" stroke="#111827" stroke-width="1.2" stroke-linejoin="round"/><path d="M1 1 L10 5.5 L5.5 10 Z" fill="#e5e7eb" stroke="#111827" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
const QUERIED_PROPERTIES = [
    "type",
    "componentType",
    "x",
    "y",
    "width",
    "height",
    "rotation",
    "locked",
    "text",
    "textLines",
    "crop",
];

let requestId = 0;
let driver = null;
let toolActive = false;
let drag = null;
let cutting = false;

const issue = (type, req) =>
    driver.issueCommand({
        type,
        driverId: driver.manifest.driverId,
        requestId: String(requestId++),
        ...(req === undefined ? {} : { req }),
    });

const snapCut = (start, end) => {
    const horizontal = Math.abs(end.x - start.x) >= Math.abs(end.y - start.y);
    return horizontal
        ? {
              horizontal,
              at: start.y,
              from: Math.min(start.x, end.x),
              to: Math.max(start.x, end.x),
          }
        : {
              horizontal,
              at: start.x,
              from: Math.min(start.y, end.y),
              to: Math.max(start.y, end.y),
          };
};

const cutLine = (lineId, cut) => ({
    type: "line",
    drawdyElementId: lineId,
    from: cut.horizontal ? [cut.from, cut.at] : [cut.at, cut.from],
    to: cut.horizontal ? [cut.to, cut.at] : [cut.at, cut.to],
    color: CUT_LINE_COLOR,
    strokeWidth: 2,
    strokeDash: "dashed",
});

const startDrag = (point) => {
    const lineId = driver.generateId();
    const cut = snapCut(point, point);
    drag = {
        start: point,
        end: point,
        lineId,
        previewId: issue("command:scene:create-drawdy-preview-elements", {
            elements: [cutLine(lineId, { ...cut, to: cut.to + 0.01 })],
        }).then(({ res }) => (res.error ? null : res.value.previewId)),
        updating: false,
    };
};

const moveDrag = async (point) => {
    if (!drag) return;
    drag.end = point;
    if (drag.updating) return;
    const current = drag;
    current.updating = true;
    try {
        await current.previewId;
        let sent;
        do {
            sent = current.end;
            await issue("command:scene:update-drawdy-preview-elements", {
                elements: [
                    cutLine(current.lineId, snapCut(current.start, sent)),
                ],
            });
        } while (current.end !== sent && drag === current);
    } finally {
        current.updating = false;
    }
};

const endDrag = async (point) => {
    const finished = drag;
    drag = null;
    if (!finished) return null;
    const previewId = await finished.previewId;
    if (previewId) {
        await issue("command:scene:delete-drawdy-preview-elements", {
            previewIds: [previewId],
        });
    }
    return point ? snapCut(finished.start, point) : null;
};

const crossedElements = async (cut) => {
    const { res } = await issue("command:scene:query-rect", {
        rect: cut.horizontal
            ? {
                  x: cut.from,
                  y: cut.at - 1,
                  width: cut.to - cut.from,
                  height: 2,
              }
            : {
                  x: cut.at - 1,
                  y: cut.from,
                  width: 2,
                  height: cut.to - cut.from,
              },
        properties: QUERIED_PROPERTIES,
    });
    if (res.error) return [];
    return res.value.drawdyElements.filter((el) => {
        if (el.locked || el.rotation) return false;
        const { crossStart, crossSize } = spanAcross(el, cut);
        return cut.from < crossStart + crossSize && cut.to > crossStart;
    });
};

const spanAcross = (el, cut) =>
    cut.horizontal
        ? {
              start: el.y,
              size: el.height,
              crossStart: el.x,
              crossSize: el.width,
          }
        : {
              start: el.x,
              size: el.width,
              crossStart: el.y,
              crossSize: el.height,
          };

const piecesAlong = (el, cut) => {
    const { start, size } = spanAcross(el, cut);
    const before = cut.at - start;
    const after = start + size - cut.at;
    if (before < MIN_PIECE_SIZE || after < MIN_PIECE_SIZE) return null;
    return { start, size, before, after };
};

const placedPastCut = (cut, at) =>
    cut.horizontal ? { y: at + SPLIT_GAP } : { x: at + SPLIT_GAP };

const planRectCut = (el, cut) => {
    const pieces = piecesAlong(el, cut);
    if (!pieces) return null;
    const sizeKey = cut.horizontal ? "height" : "width";
    return {
        id: el.id,
        original: { [sizeKey]: pieces.before },
        copy: {
            transform: placedPastCut(cut, cut.at),
            [sizeKey]: pieces.after,
        },
    };
};

const planImageCut = (el, cut) => {
    const pieces = piecesAlong(el, cut);
    if (!pieces) return null;
    const crop = el.crop ?? { topLeft: [0, 0], bottomRight: [1, 1] };
    const axis = cut.horizontal ? 1 : 0;
    const from = crop.topLeft[axis];
    const to = crop.bottomRight[axis];
    const at = from + (pieces.before / pieces.size) * (to - from);
    if (at - from < MIN_CROP_SPAN || to - at < MIN_CROP_SPAN) return null;
    const withAxis = (point, value) =>
        point.map((v, i) => (i === axis ? value : v));
    return {
        id: el.id,
        original: {
            crop: {
                topLeft: crop.topLeft,
                bottomRight: withAxis(crop.bottomRight, at),
            },
        },
        copy: {
            crop: {
                topLeft: withAxis(crop.topLeft, at),
                bottomRight: crop.bottomRight,
            },
            transform: placedPastCut(cut, cut.at),
        },
    };
};

const planTextCut = (el, cut) => {
    const lines = el.textLines ?? [];
    if (!cut.horizontal || lines.length < 2) return null;
    let boundary = 1;
    for (let i = 2; i < lines.length; i++) {
        if (
            Math.abs(lines[i].y - cut.at) < Math.abs(lines[boundary].y - cut.at)
        ) {
            boundary = i;
        }
    }
    let lastAbove = boundary - 1;
    while (lastAbove > 0 && lines[lastAbove].text === "") lastAbove--;
    let firstBelow = boundary;
    while (firstBelow < lines.length - 1 && lines[firstBelow].text === "") {
        firstBelow++;
    }
    const above = el.text.slice(0, lines[lastAbove].end);
    const below = el.text.slice(lines[firstBelow].start);
    if (above.trim() === "" || below.trim() === "") return null;
    return {
        id: el.id,
        original: { text: above },
        copy: {
            text: below,
            transform: placedPastCut(cut, lines[firstBelow].y),
        },
    };
};

const planCut = (el, cut) => {
    if (el.type === "image") return planImageCut(el, cut);
    if (el.type === "text") return planTextCut(el, cut);
    if (el.type === "path" && el.componentType === "rect") {
        return planRectCut(el, cut);
    }
    return null;
};

const applyCuts = async (plans) => {
    if (plans.length === 0) return;
    const duplicated = await issue("command:scene:duplicate-drawdy-elements", {
        duplicates: plans.map(({ id, copy }) => ({
            drawdyElementId: id,
            properties: copy,
        })),
    });
    if (duplicated.res.error) {
        console.error("split: could not duplicate", duplicated.res);
        return;
    }
    const copied = duplicated.res.value.newDrawdyElementIds;
    const updates = plans
        .filter(({ id }) => id in copied)
        .map(({ id, original }) => ({
            drawdyElementId: id,
            properties: original,
        }));
    if (updates.length === 0) return;
    const updated = await issue("command:scene:update-drawdy-elements", {
        updates,
    });
    if (updated.res.error) console.error("split: could not cut", updated.res);
};

exports.activate = async ({ manifest, issueCommand, generateId }) => {
    driver = { manifest, issueCommand, generateId };
    const { res } = await issue("command:tools:register-custom-tool", {
        name: TOOL_NAME,
        toolbarIcon: { type: "svg", value: CUTTER_ICON },
        cursorIcon: { type: "svg", value: CUTTER_ICON },
    });
    if (res.error || !res.value.created) {
        console.error("split: could not register the tool", res);
        return;
    }
    await issue("subscription:tool:change");
    await issue("subscription:scene:pointer", {});
    await issue("subscription:scene:pointer-position");
    const active = await issue("command:tools:get-active");
    toolActive = !active.res.error && active.res.value.toolId === TOOL_NAME;
};

exports.onEvent = async (e) => {
    if (!driver) return;
    switch (e.type) {
        case "subscription:tool:change":
            toolActive = e.body.name === TOOL_NAME;
            if (!toolActive) await endDrag(null);
            return;
        case "subscription:scene:pointer-position":
            if (toolActive) await moveDrag(e.body.position.canvasSpace);
            return;
        case "subscription:scene:pointer": {
            if (e.body.type === "cancel") {
                await endDrag(null);
                return;
            }
            if (!toolActive) return;
            if (e.body.type === "down" && !drag && !cutting) {
                startDrag(e.body.cursor.canvasSpace);
                return;
            }
            if (e.body.type !== "up" || !drag) return;
            cutting = true;
            try {
                const cut = await endDrag(e.body.cursor.canvasSpace);
                if (!cut || cut.to - cut.from < MIN_CUT_LENGTH) return;
                const elements = await crossedElements(cut);
                await applyCuts(
                    elements.map((el) => planCut(el, cut)).filter(Boolean)
                );
            } finally {
                cutting = false;
            }
            return;
        }
    }
};
