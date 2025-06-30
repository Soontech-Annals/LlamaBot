import { SlashCommandBuilder, ChatInputCommandInteraction, InteractionContextType, MessageFlags } from "discord.js";
import { GuildHolder } from "../GuildHolder.js";
import { Command } from "../interface/Command.js";
import { replyEphemeral, truncateStringWithEllipsis } from "../utils/Util.js";

export class GetThanksCommand implements Command {
    getID(): string {
        return "getthanks";
    }

    getBuilder(_guildHolder: GuildHolder): SlashCommandBuilder {
        const data = new SlashCommandBuilder()
        data.setName(this.getID())
            .setDescription('Get the amount of thank-you points from a member')
            .setContexts(InteractionContextType.Guild);
        data.addUserOption(option =>
            option.setName('user')
                .setDescription('The user to get the thank-you points for')
                .setRequired(true)
        );
        return data;
    }

    async execute(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction): Promise<void> {
        if (
            !interaction.inGuild()
        ) {
            await replyEphemeral(interaction, 'This command can only be used in a forum channel.')
            return;
        }

        // Get the user to check
        const user = interaction.options.getUser('user', true);
        const userData = await guildHolder.getUserManager().getUserData(user.id);
        if (!userData) {
            await replyEphemeral(interaction, `No data found for user <@${user.id}>.`);
            return;
        }
        
        const origMessage = await interaction.reply({
            content: `Fetching thank-you points...`,
            flags: [MessageFlags.SuppressNotifications]
        });

        let message = `<@${userData.id}> has a total of ${userData.thankedCountTotal} thank-you points in this server.`;
        
        if (userData.thankedBuffer.length > 0) {
            message += `\n\n**${userData.thankedBuffer.length} Thanks recieved in the last 30 days:** ${userData.thankedBuffer.length > 15 ? '(showing most recent 15)' : ''}`;
            const buffer = userData.thankedBuffer.slice(0);
            buffer.reverse(); // Reverse the buffer to show the most recent first
            if (buffer.length > 15) {
                buffer.splice(0, buffer.length - 15); // Limit to the most recent 15
            }
            for (const thanked of buffer) {
                const url = `https://discord.com/channels/${guildHolder.getGuild().id}/${thanked.channelId}/${thanked.messageId}`;
                message += `\n- <t:${Math.floor(thanked.timestamp/1000)}:D>, thanked by <@${thanked.thankedBy}> for ${url}`;
            }
        }

        await origMessage.edit({
            content: truncateStringWithEllipsis(message, 2000),
        });

    }

}