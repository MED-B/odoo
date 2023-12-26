/** @odoo-module */

import { Follower } from "@mail/core/follower_model";
import { ThreadService, threadService } from "@mail/core/thread_service";
import { createLocalId } from "@mail/utils/misc";
import { parseEmail } from "@mail/js/utils";

import { markup } from "@odoo/owl";

import { _t } from "@web/core/l10n/translation";
import { patch } from "@web/core/utils/patch";

let nextId = 1;

patch(ThreadService.prototype, "mail/web", {
    setup(env, services) {
        this._super(env, services);
        this.action = services.action;
        /** @type {import("@mail/attachments/attachment_service").AttachmentService} */
        this.attachmentService = services["mail.attachment"];
        /** @type {import("@mail/web/activity/activity_service").ActivityService} */
        this.activityService = services["mail.activity"];
        /** @type {import("@mail/chat/chat_window_service").ChatWindowService} */
        this.chatWindowService = services["mail.chat_window"];
    },
    /**
     * @param {import("@mail/core/thread_model").Thread} thread
     * @param {['activities'|'followers'|'attachments'|'messages'|'suggestedRecipients']} requestList
     */
    async fetchData(
        thread,
        requestList = ["activities", "followers", "attachments", "messages", "suggestedRecipients"]
    ) {
        thread.isLoadingAttachments =
            thread.isLoadingAttachments || requestList.includes("attachments");
        if (requestList.includes("messages")) {
            this.fetchNewMessages(thread);
        }
        const result = await this.rpc("/mail/thread/data", {
            request_list: requestList,
            thread_id: thread.id,
            thread_model: thread.model,
        });
        if ("attachments" in result) {
            result["attachments"] = result["attachments"].map((attachment) => ({
                ...attachment,
                originThread: this.insert(attachment.originThread[0][1]),
            }));
        }
        thread.canPostOnReadonly = result.canPostOnReadonly;
        thread.hasReadAccess = result.hasReadAccess;
        thread.hasWriteAccess = result.hasWriteAccess;
        if ("activities" in result) {
            const existingIds = new Set();
            for (const activity of result.activities) {
                if (activity.note) {
                    activity.note = markup(activity.note);
                }
                existingIds.add(this.activityService.insert(activity).id);
            }
            for (const activity of thread.activities) {
                if (!existingIds.has(activity.id)) {
                    this.activityService.delete(activity);
                }
            }
        }
        if ("attachments" in result) {
            this.update(thread, {
                areAttachmentsLoaded: true,
                attachments: result.attachments,
                isLoadingAttachments: false,
            });
        }
        if ("mainAttachment" in result) {
            thread.mainAttachment = result.mainAttachment.id
                ? this.attachmentService.insert(result.mainAttachment)
                : undefined;
        }
        if (!thread.mainAttachment && thread.attachmentsInWebClientView.length > 0) {
            this.setMainAttachmentFromIndex(thread, 0);
        }
        if ("followers" in result) {
            for (const followerData of result.followers) {
                this.insertFollower({
                    followedThread: thread,
                    ...followerData,
                });
            }
        }
        if ("suggestedRecipients" in result) {
            this.insertSuggestedRecipients(thread, result.suggestedRecipients);
        }
        return result;
    },
    getThread(resModel, resId) {
        const localId = createLocalId(resModel, resId);
        if (localId in this.store.threads) {
            if (resId === false) {
                return this.store.threads[localId];
            }
            // to force a reload
            this.store.threads[localId].status = "new";
        }
        const thread = this.insert({
            id: resId,
            model: resModel,
            type: "chatter",
        });
        if (resId === false) {
            const tmpId = this.messageService.getNextTemporaryId();
            const tmpData = {
                id: tmpId,
                author: { id: this.store.self.id },
                body: _t("Creating a new record..."),
                message_type: "notification",
                trackingValues: [],
                res_id: thread.id,
                model: thread.model,
            };
            const message = this.messageService.insert(tmpData);
            thread.messages.push(message);
        }
        return thread;
    },
    /**
     * @param {import("@mail/core/follower_model").Data} data
     * @returns {import("@mail/core/follower_model").Follower}
     */
    insertFollower(data) {
        let follower = this.store.followers[data.id];
        if (!follower) {
            this.store.followers[data.id] = new Follower();
            follower = this.store.followers[data.id];
        }
        Object.assign(follower, {
            followedThread: data.followedThread,
            id: data.id,
            isActive: data.is_active,
            partner: this.personaService.insert({ ...data.partner, type: "partner" }),
            _store: this.store,
        });
        follower.followedThread.followers.add(follower);
        return follower;
    },
    /**
     * @param {import("@mail/core/thread_model").Thread} thread
     * @param {import("@mail/web/suggested_recipient").SuggestedRecipient[]} dataList
     */
    async insertSuggestedRecipients(thread, dataList) {
        const recipients = [];
        for (const data of dataList) {
            const [partner_id, emailInfo, lang, reason, defaultCreateValues] = data;
            let [name, email] = emailInfo ? parseEmail(emailInfo) : [];
            if ((!name || name === email) && defaultCreateValues?.name) {
                name = defaultCreateValues.name;
            }
            recipients.push({
                id: nextId++,
                name,
                email,
                lang,
                reason,
                persona: partner_id
                    ? this.personaService.insert({
                          type: "partner",
                          id: partner_id,
                      })
                    : false,
                checked: true,
                defaultCreateValues,
            });
        }
        thread.suggestedRecipients = recipients;
    },
    open(thread, replaceNewMessageChatWindow) {
        if (!this.store.discuss.isActive && !this.store.isSmall) {
            this._openChatWindow(thread, replaceNewMessageChatWindow);
            return;
        }
        if (this.store.isSmall && thread.model === "discuss.channel") {
            this._openChatWindow(thread, replaceNewMessageChatWindow);
            return;
        }
        if (thread.model !== "discuss.channel") {
            this.action.doAction({
                type: "ir.actions.act_window",
                res_id: thread.id,
                res_model: thread.model,
                views: [[false, "form"]],
            });
            return;
        }
        this._super(thread, replaceNewMessageChatWindow);
    },
    remove(channel) {
        const chatWindow = this.store.chatWindows.find((c) => c.threadLocalId === channel.localId);
        if (chatWindow) {
            this.chatWindowService.close(chatWindow);
        }
        this._super(...arguments);
    },
    /**
     * @param {import("@mail/core/follower_model").Follower} follower
     */
    async removeFollower(follower) {
        await this.orm.call(follower.followedThread.model, "message_unsubscribe", [
            [follower.followedThread.id],
            [follower.partner.id],
        ]);
        follower.followedThread.followers.delete(follower);
        delete this.store.followers[follower.id];
    },
    unpin(thread) {
        const chatWindow = this.store.chatWindows.find((c) => c.threadLocalId === thread.localId);
        if (chatWindow) {
            this.chatWindowService.close(chatWindow);
        }
        this._super(...arguments);
    },
    _openChatWindow(thread, replaceNewMessageChatWindow) {
        const chatWindow = this.chatWindowService.insert({
            folded: false,
            thread,
            replaceNewMessageChatWindow,
        });
        chatWindow.autofocus++;
        if (thread) {
            thread.state = "open";
        }
        this.chatWindowService.notifyState(chatWindow);
    },
});

patch(threadService, "mail/web", {
    dependencies: [
        ...threadService.dependencies,
        "action",
        "mail.activity",
        "mail.attachment",
        "mail.chat_window",
    ],
});
