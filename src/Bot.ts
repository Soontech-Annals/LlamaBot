import { ChatInputCommandInteraction, Client, Events, GatewayIntentBits, Message, Partials, SelectMenuInteraction } from "discord.js";
import { GuildHolder } from "./GuildHolder.js";
import { LLMQueue } from "./llm/LLMQueue.js";
import path from "path";
import fs from "fs/promises";
import { Command } from "./interface/Command.js";
import { Button } from "./interface/Button.js";
import { Menu } from "./interface/Menu.js";
import { Modal } from "./interface/Modal.js";
import { deployCommands, getItemsFromArray, replyEphemeral } from "./utils/Util.js";
import { getButtons } from "./components/buttons/index.js";
import { getCommands } from "./commands/index.js";
import { getMenus } from "./components/menus/index.js";
import { getModals } from "./components/modals/index.js";
import { TempDataStore } from "./utils/TempDataStore.js";
import { App } from "octokit";
/**
 * The Secrets type defines the structure for the bot's secrets, including the token and client ID.
 */
export type Secrets = {
    token: string;
    clientId: string;
    githubAppId: string;
}

/**
 * The Bot class is responsible for managing the Discord bot's lifecycle across multiple guilds.
 */
export class Bot {
    /**
     * A map of guild IDs to GuildHolder instances, which manage the state and interactions for each guild.
     */
    guilds: Map<string, GuildHolder>;

    /**
      * The discord.js Client instance used to interact with the Discord API.
      */
    client: Client;

    /**
     * The LLM request queue, which holds requests to be processed by the LLM.
     */
    llmQueue: LLMQueue;

    /**
     * Commands available for the bot, loaded from the commands directory.
     */
    commands: Map<string, Command>;

    /**
     * Buttons available for the bot, loaded from the buttons directory.
     */
    buttons: Map<string, Button>;

    /**
     * Menus available for the bot, loaded from the menus directory.
     */
    menus: Map<string, Menu>;

    /**
     * Modals available for the bot, loaded from the modals directory.
     */
    modals: Map<string, Modal>;

    /**
     * Indicates whether the bot is ready and connected to Discord.
     */
    ready: boolean = false;

    /**
     * Temp data store
     */
    tempData: TempDataStore;

    /**
     * Github client
     */
    githubClient?: App;


    constructor() {
        this.guilds = new Map()
        this.llmQueue = new LLMQueue()
        this.commands = new Map()
        this.buttons = new Map()
        this.menus = new Map()
        this.modals = new Map()
        this.tempData = new TempDataStore();

        this.client = new Client({
            intents: [
                GatewayIntentBits.DirectMessages,
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMembers,
                GatewayIntentBits.GuildModeration
            ],
            partials: [
                Partials.Channel,
                Partials.Message,
                Partials.Reaction
            ]
        });
    }

    async start() {
        const secretsPath = path.join(process.cwd(), 'secrets.json')
        const secrets = JSON.parse(await fs.readFile(secretsPath, 'utf-8')) as Secrets
        if (!secrets.token || !secrets.clientId) {
            throw new Error('Missing token or clientId in secrets.json')
        }

        this.commands = getItemsFromArray(getCommands())
        this.buttons = getItemsFromArray(getButtons())
        this.menus = getItemsFromArray(getMenus());
        this.modals = getItemsFromArray(getModals());

        this.setupListeners(secrets)
        this.client.login(secrets.token)


        this.githubClient = new App({
            appId: secrets.githubAppId,
            privateKey: await fs.readFile(path.join(process.cwd(), 'key.pem'), 'utf-8'),
        });

        return new Promise((resolve, reject) => {
            this.client.once('ready', async () => {
                this.ready = true

                const guilds = await Promise.all((await this.client.guilds.fetch()).map((guild) => guild.fetch()))
                guilds.forEach((guild) => {
                    const holder = new GuildHolder(this, guild);
                    this.guilds.set(guild.id, holder);
                    deployCommands(this.commands, holder, secrets)
                })

                this.loop()

                console.log('Bot is ready')
                resolve(this)
            })

            this.client.once('error', (err) => {
                console.error('Error starting bot:', err)
                reject(err)
            })
        })
    }

    setupListeners(secrets: Secrets) {
        this.client.on(Events.GuildCreate, (guild) => {
            console.log(`Joined guild: ${guild.name} (${guild.id})`)
            const holder = this.guilds.get(guild.id) ?? new GuildHolder(this, guild);
            this.guilds.set(guild.id, holder);
            deployCommands(this.commands, holder, secrets)
        })

        this.client.on(Events.GuildDelete, (guild) => {
            console.log(`Left guild: ${guild.name} (${guild.id})`)
            this.guilds.delete(guild.id)
        })

        this.client.on(Events.InteractionCreate, async (interaction) => {
            if (!interaction.inGuild()) {
                replyEphemeral(interaction, 'Cannot use outside of guild!')
                return;
            }

            const guildHolder = this.guilds.get(interaction.guildId)
            if (!guildHolder) {
                replyEphemeral(interaction, 'Guild not found!')
                return;
            }

            if (interaction.isCommand()) {
                const command = this.commands.get(interaction.commandName)
                if (!command) return

                try {
                    await command.execute(guildHolder, interaction as ChatInputCommandInteraction)
                } catch (error) {
                    console.error(error)
                    return replyEphemeral(interaction, 'An error occurred while executing the command.')
                }
            } else if (interaction.isButton()) {
                const customId = interaction.customId.split('|')
                const button = this.buttons.get(customId[0])
                if (!button) return

                try {
                    await button.execute(guildHolder, interaction, ...customId.slice(1))
                } catch (error) {
                    console.error(error)
                    return replyEphemeral(interaction, 'An error occurred while executing the button.')
                }
            } else if (interaction.isAnySelectMenu()) {
                const customId = interaction.customId.split('|')
                const menu = this.menus.get(customId[0])
                if (!menu) return

                try {
                    await menu.execute(guildHolder, interaction as SelectMenuInteraction, ...customId.slice(1))
                } catch (error) {
                    console.error(error)
                    return replyEphemeral(interaction, 'An error occurred while executing the menu.')
                }
            } else if (interaction.isModalSubmit()) {
                const customId = interaction.customId.split('|')
                const modal = this.modals.get(customId[0])
                if (!modal) return

                try {
                    await modal.execute(guildHolder, interaction, ...customId.slice(1))
                } catch (error) {
                    console.error(error)
                    return replyEphemeral(interaction, 'An error occurred while executing the modal.')
                }
            } else {
                return replyEphemeral(interaction, 'Unknown interaction type!')
            }
        })

        this.client.on(Events.MessageCreate, async (message) => {
            if (message.partial) {
                message.fetch()
                    .then(fullMessage => {
                        console.log(fullMessage.content);
                    })
                    .catch(error => {
                        console.log('Something went wrong when fetching the message: ', error);
                    });
            }

            if (message.author.bot) return
            if (!message.inGuild()) {
                await this.handleAdminMessage(message)
                return
            }

            const guildHolder = this.guilds.get(message.guildId)
            if (!guildHolder) return

            // Handle message in guild
            try {
                await guildHolder.handleMessage(message)
            } catch (error) {
                console.error('Error handling message:', error)
            }
        })


        this.client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
            if (newMessage.partial) {
                newMessage.fetch()
                    .then(fullMessage => {
                        console.log(fullMessage.content);
                    })
                    .catch(error => {
                        console.log('Something went wrong when fetching the message: ', error);
                    });
            }

            if (newMessage.author.bot) return
            if (!oldMessage.inGuild() || !newMessage.inGuild()) return

            const guildHolder = this.guilds.get(newMessage.guildId)
            if (!guildHolder) return

            // Handle message in guild
            try {
                await guildHolder.handleMessageUpdate(oldMessage, newMessage)
            } catch (error) {
                console.error('Error handling message update:', error)
            }
        });


        this.client.on(Events.MessageDelete, async (message) => {
            if (!message.author) return
            if (!message.inGuild()) return

            const guildHolder = this.guilds.get(message.guildId)
            if (!guildHolder) return

            // Handle message in guild
            try {
                await guildHolder.handleMessageDelete(message)
            } catch (error) {
                console.error('Error handling message delete:', error)
            }
        })

        this.client.on(Events.ThreadDelete, async (thread) => {
            if (!thread.isTextBased()) return


            const guildHolder = this.guilds.get(thread.guildId)
            if (!guildHolder) return

            // Handle message in guild
            try {
                await guildHolder.handleThreadDelete(thread)
            } catch (error) {
                console.error('Error handling thread delete:', error)
            }
        })

        this.client.on(Events.ThreadUpdate, async (oldThread, newThread) => {
            if (!newThread.isTextBased()) return

            const guildHolder = this.guilds.get(newThread.guildId)
            if (!guildHolder) return

            // Handle message in guild
            try {
                await guildHolder.handleThreadUpdate(oldThread, newThread)
            } catch (error) {
                console.error('Error handling thread update:', error)
            }
        });

        this.client.on('error', (error) => {
            console.error('Discord client error:', error)
        })
    }

    async loop() {
        if (!this.ready) {
            console.error('Bot is not ready')
            return
        }

        for (const guildHolder of this.guilds.values()) {
            await guildHolder.loop()
        }

        setTimeout(() => this.loop(), 1000)
    }

    public getTempDataStore(): TempDataStore {
        return this.tempData;
    }

    /**
     * Get the Github installation token for an organization.
     * @param orgId The ID of the organization.
     */
    public async getGithubInstallationToken(orgId: string): Promise<string> {
        const installations: { access_tokens_url: any; }[] = [];
        await this.githubClient?.eachInstallation(({ installation }) => {
            if (installation.account?.login === orgId) {
                installations.push(installation);
            }
        });

        if (installations.length === 0) {
            throw new Error(`No GitHub installation found for organization ${orgId}`);
        }

        const url = installations[0].access_tokens_url;

        const response = await this.githubClient?.octokit.request('POST ' + url, {
            headers: {
                'Accept': 'application/vnd.github+json',
            }
        });

        if (!response || !response.data || !response.data.token) {
            throw new Error(`Failed to get GitHub installation token for organization ${orgId}`);
        }
        return response.data.token;
    }

    public async handleAdminMessage(message: Message) {
        // Check if dm and author is `239078039831445504`
        console.log(`Received admin message: ${message.content} from ${message.author.tag} (${message.author.id})`);
        if (message.inGuild()) return;
        if (message.author.id !== '239078039831445504') return;

        // Check if the message starts with `/`
        if (!message.content.startsWith('/')) {
            return message.reply('Please start your command with `/`');
        }

        // Split the message into command and args
        const args = message.content.slice(1).trim().split(/ +/);
        const commandName = args.shift()?.toLowerCase();
        if (!commandName) {
            return message.reply('Please provide a command.');
        }

        // Check if its refresh
        if (commandName === 'refresh') {

            await message.reply('Running git pull...');
            try {
                await fs.access(path.join(process.cwd(), '.git'));
                const { exec } = await import('child_process');
                exec('git pull', { cwd: process.cwd() }, async (error, stdout, _stderr) => {
                    if (error) {
                        console.error(`Error pulling changes: ${error.message}`);
                        return message.reply(`Error pulling changes: ${error.message}`);
                    }
                    console.log(`Git pull output: ${stdout}`);
                    return message.reply('Bot refreshed successfully!');
                });
            } catch (err) {
                console.error('Not a git repository:', err);
                return message.reply('Not a git repository. Cannot refresh.');
            }
        } else {
            return message.reply(`Unknown command: ${commandName}`);
        }


    }
}
