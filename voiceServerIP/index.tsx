/*
 * Vencord userplugin: VoiceServerIP
 * Показывает IP голосового сервера и серверов Go Live стримов.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { copyToClipboard } from "@utils/clipboard";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, FluxDispatcher, GuildStore, SelectedChannelStore, Toasts, UserStore } from "@webpack/common";

const logger = new Logger("VoiceServerIP", "#43b581");

const settings = definePluginSettings({
    notifyVoice: {
        type: OptionType.BOOLEAN,
        description: "Уведомлять при подключении к голосовому каналу",
        default: true
    },
    notifyOwnStream: {
        type: OptionType.BOOLEAN,
        description: "Уведомлять при запуске своего стрима",
        default: true
    },
    notifyWatchedStream: {
        type: OptionType.BOOLEAN,
        description: "Уведомлять при открытии чужого стрима",
        default: true
    },
    notifyUnknown: {
        type: OptionType.BOOLEAN,
        description: "Уведомлять о медиа-соединениях, которые не удалось опознать",
        default: true
    },
    knownAddresses: {
        type: OptionType.STRING,
        displayName: "Известные адреса",
        description: "Адреса, о которых не уведомлять: по одному в строке, адрес IPv4 или подсеть вида 1.1.1.0/24. Строка, начинающаяся с #, пропускается",
        default: "",
        multiline: true,
        placeholder: "66.22.196.0/24\n66.22.200.15",
        isValid(value: string) {
            const { errors } = parseKnownAddresses(value ?? "");
            return errors.length ? `Адрес не разобран: ${errors[0]}` : true;
        }
    },
    copyWithPort: {
        type: OptionType.BOOLEAN,
        description: "Копировать адрес вместе с портом (ip:port)",
        default: false
    },
    permanent: {
        type: OptionType.BOOLEAN,
        description: "Не скрывать уведомление автоматически (закрывать вручную)",
        default: false
    },
    logToConsole: {
        type: OptionType.BOOLEAN,
        description: "Дублировать всё в консоль DevTools",
        default: true
    }
});

type ConnKind = "voice" | "own-stream" | "watch-stream";

interface PendingConn {
    kind: ConnKind;
    label: string;
    endpoint: string;
    at: number;
}

/** token из *_SERVER_UPDATE -> описание соединения. Токен уникален для каждого RTC-соединения. */
const pending = new Map<string, PendingConn>();
/** ключ дедупликации -> время, чтобы переподключения не спамили одинаковыми уведомлениями */
const recent = new Map<string, number>();

const PENDING_TTL = 120_000;
const DEDUPE_MS = 5_000;

/** Голосовые/медиа-серверы: xxx1234.discord.media, легаси — city1234.discord.gg */
const MEDIA_HOST_RE = /\.discord\.(media|gg)(:|\/|$)/;

function prune() {
    const now = Date.now();
    for (const [token, info] of pending)
        if (now - info.at > PENDING_TTL) pending.delete(token);
    for (const [key, at] of recent)
        if (now - at > DEDUPE_MS) recent.delete(key);
}

function hostOf(url: string) {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

interface Subnet {
    base: number;
    mask: number;
}

function ipToInt(ip: string) {
    const parts = ip.split(".");
    if (parts.length !== 4) return null;

    let value = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;

        const octet = Number(part);
        if (octet > 255) return null;

        value = value * 256 + octet;
    }
    return value;
}

function parseKnownAddresses(raw: string) {
    const nets: Subnet[] = [];
    const errors: string[] = [];

    for (const line of raw.split("\n")) {
        const entry = line.trim();
        if (!entry || entry.startsWith("#")) continue;

        const [address, bitsRaw] = entry.split("/");
        const base = ipToInt(address);
        const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);

        if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
            errors.push(entry);
            continue;
        }

        const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
        nets.push({ base: (base & mask) >>> 0, mask });
    }

    return { nets, errors };
}

let knownCache: { raw: string; nets: Subnet[]; } | null = null;

function isKnownAddress(ip: string) {
    const raw = settings.store.knownAddresses ?? "";
    if (!raw.trim()) return false;

    if (knownCache?.raw !== raw)
        knownCache = { raw, nets: parseKnownAddresses(raw).nets };

    const value = ipToInt(ip);
    if (value === null) return false;

    return knownCache.nets.some(net => ((value & net.mask) >>> 0) === net.base);
}

function channelName(channelId: string | null | undefined) {
    if (!channelId) return null;

    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return null;
    if (channel.name) return channel.name;

    // У личных и групповых звонков имени нет, остаются имена собеседников
    const recipients: any[] = (channel as any).rawRecipients ?? [];
    const names = recipients.map(r => r?.username).filter(Boolean);
    return names.length ? names.join(", ") : null;
}

function describeVoice(e: any) {
    // Канала в событии может не быть: к моменту его прихода канал уже выбран в клиенте
    const channelId = e.channelId ?? e.channel_id ?? SelectedChannelStore.getVoiceChannelId();
    const name = channelName(channelId);
    if (name) return name;

    const guildId = e.guildId ?? e.guild_id;
    return GuildStore.getGuild(guildId)?.name ?? "личный звонок";
}

/** stream_key: "guild:<guildId>:<channelId>:<userId>" либо "call:<channelId>:<userId>" */
function describeStream(streamKey: string) {
    const parts = String(streamKey).split(":");
    const ownerId = parts[parts.length - 1];
    const channel = channelName(parts[parts.length - 2]);
    const isOwn = !!ownerId && ownerId === UserStore.getCurrentUser()?.id;

    if (isOwn) return { isOwn, label: channel ?? "стрим" };

    const owner = ownerId ? UserStore.getUser(ownerId) : null;
    const who = `стрим ${owner?.username ?? ownerId ?? "?"}`;
    return { isOwn, label: channel ? `${channel} · ${who}` : who };
}

function onVoiceServerUpdate(e: any) {
    if (settings.store.logToConsole) logger.debug("VOICE_SERVER_UPDATE", e);

    // endpoint === null => сервер отвалился и переназначается, соединения не будет
    if (!e?.token || !e?.endpoint) return;

    pending.set(e.token, {
        kind: "voice",
        label: describeVoice(e),
        endpoint: e.endpoint,
        at: Date.now()
    });
    prune();
}

function onStreamServerUpdate(e: any) {
    if (settings.store.logToConsole) logger.debug("STREAM_SERVER_UPDATE", e);

    if (!e?.token || !e?.endpoint) return;

    const { isOwn, label } = describeStream(e.streamKey ?? e.stream_key ?? "");

    pending.set(e.token, {
        kind: isOwn ? "own-stream" : "watch-stream",
        label,
        endpoint: e.endpoint,
        at: Date.now()
    });
    prune();
}

function isEnabledFor(kind: ConnKind | null) {
    switch (kind) {
        case "voice": return settings.store.notifyVoice;
        case "own-stream": return settings.store.notifyOwnStream;
        case "watch-stream": return settings.store.notifyWatchedStream;
        default: return settings.store.notifyUnknown;
    }
}

function titleFor(kind: ConnKind | null) {
    switch (kind) {
        case "voice": return "Голосовой сервер";
        case "own-stream": return "Сервер стрима (исходящий)";
        case "watch-stream": return "Сервер стрима (просмотр)";
        default: return "Медиа-сервер Discord";
    }
}

function report(wsUrl: string, ip: string, port: number, info: PendingConn | null) {
    const kind = info?.kind ?? null;
    const host = hostOf(wsUrl);
    const address = `${ip}:${port}`;
    const known = isKnownAddress(ip);

    if (settings.store.logToConsole)
        logger.info(
            `${titleFor(kind)}: ${address} (${host})${info ? ` — ${info.label}` : ""}` +
            (known ? " — адрес в списке известных, уведомление пропущено" : "")
        );

    if (known || !isEnabledFor(kind)) return;

    const dedupeKey = `${kind ?? "?"}|${address}`;
    const now = Date.now();
    if (now - (recent.get(dedupeKey) ?? 0) < DEDUPE_MS) return;
    recent.set(dedupeKey, now);

    const lines = [address, info?.label ?? "не опознано", host].join("\n");
    const toCopy = settings.store.copyWithPort ? address : ip;

    showNotification({
        title: titleFor(kind),
        // body уходит в системное уведомление и в журнал, richBody — во внутреннее окно
        body: lines,
        richBody: (
            <p className="vc-notification-p" style={{ whiteSpace: "pre-line" }}>
                {lines}
            </p>
        ),
        color: kind === "voice" ? "#43b581" : "#5865f2",
        permanent: settings.store.permanent,
        onClick() {
            copyToClipboard(toCopy).then(() => {
                Toasts.show({
                    id: Toasts.genId(),
                    type: Toasts.Type.SUCCESS,
                    message: `Скопировано: ${toCopy}`
                });
            }).catch(err => logger.error("Не удалось скопировать", err));
        }
    });
}

let OriginalWebSocket: typeof WebSocket | null = null;

function installHook() {
    if (OriginalWebSocket) return;

    OriginalWebSocket = window.WebSocket;
    const Base = OriginalWebSocket;

    class MediaSpyWebSocket extends Base {
        private vcMedia = false;
        private vcInfo: PendingConn | null = null;

        constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);

            const href = String(url);
            this.vcMedia = MEDIA_HOST_RE.test(href);
            if (!this.vcMedia) return;

            this.addEventListener("message", ev => {
                // DAVE/E2EE шлёт бинарные фреймы — они нам не нужны
                if (typeof ev.data !== "string") return;

                let msg: any;
                try {
                    msg = JSON.parse(ev.data);
                } catch {
                    return;
                }

                // op 2 = Ready: ip/port того самого UDP-сервера, на который пойдёт медиатрафик
                if (msg?.op !== 2 || !msg.d?.ip) return;

                try {
                    report(href, msg.d.ip, msg.d.port, this.vcInfo);
                } catch (err) {
                    logger.error("Ошибка при обработке Ready", err);
                }
            });
        }

        send(data: any) {
            // op 0 = Identify: по token матчим сокет с тем, что пришло в flux-событии
            if (this.vcMedia && typeof data === "string") {
                try {
                    const msg = JSON.parse(data);
                    if (msg?.op === 0 && msg.d?.token)
                        this.vcInfo = pending.get(msg.d.token) ?? null;
                } catch {
                    // не JSON — игнорируем
                }
            }

            super.send(data);
        }
    }

    window.WebSocket = MediaSpyWebSocket as unknown as typeof WebSocket;
}

function uninstallHook() {
    if (!OriginalWebSocket) return;

    window.WebSocket = OriginalWebSocket;
    OriginalWebSocket = null;
}

export default definePlugin({
    name: "VoiceServerIP",
    description: "Показывает IP голосового сервера и серверов Go Live стримов при подключении. Клик по уведомлению копирует адрес в буфер.",
    authors: [{ name: "erratic", id: 0n }],
    settings,

    start() {
        installHook();
        FluxDispatcher.subscribe("VOICE_SERVER_UPDATE" as any, onVoiceServerUpdate);
        FluxDispatcher.subscribe("STREAM_SERVER_UPDATE" as any, onStreamServerUpdate);
    },

    stop() {
        FluxDispatcher.unsubscribe("VOICE_SERVER_UPDATE" as any, onVoiceServerUpdate);
        FluxDispatcher.unsubscribe("STREAM_SERVER_UPDATE" as any, onStreamServerUpdate);
        uninstallHook();
        pending.clear();
        recent.clear();
        knownCache = null;
    }
});
