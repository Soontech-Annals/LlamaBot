import { Bot } from '../Bot.js'
import { Message, TextBasedChannel, TextThreadChannel } from 'discord.js'
import { Attachment } from '../submissions/Attachment.js'
import { Image } from '../submissions/Image.js'
import Path from 'path'
import fs from 'fs/promises'
import got from 'got'
import sharp from 'sharp'
import { Litematic } from '@kleppe/litematic-reader'
import { MCMeta } from './MCMeta.js'
import { escapeString } from './Util.js'
import yauzl from "yauzl"
import nbt from 'prismarine-nbt'

export async function processImages(images: Image[], download_folder: string, processed_folder: string, bot: Bot): Promise<Image[]> {
    if (images.length > 0) {
        // Check if the folders exist, if not, create them
        if (!await fs.access(download_folder).then(() => true).catch(() => false)) {
            await fs.mkdir(download_folder, { recursive: true });
        }
        if (!await fs.access(processed_folder).then(() => true).catch(() => false)) {
            await fs.mkdir(processed_folder, { recursive: true });
        }
    }

    // Remove images that are already processed but not in the current list
    const existingFiles = await fs.readdir(processed_folder);
    await Promise.all(existingFiles.map(async file => {
        // check if the file is in the images list
        const fileKey = file.toLowerCase();
        if (!images.some(image => getFileKey(image, 'png') === fileKey)) {
            const filePath = Path.join(processed_folder, file);
            try {
                await fs.unlink(filePath);
            } catch (err) {
                console.error(`Failed to remove file ${filePath}:`, err);
            }
        }
    }));

    const imageURLs = images.map(image => image.url);
    const refreshedURLs = await refreshAttachments(imageURLs, bot);

    await Promise.all(images.map(async (image, i) => {
        const processedPath = Path.join(processed_folder, getFileKey(image, 'png'));
        // If the processed image already exists, skip processing
        if (await fs.access(processedPath).then(() => true).catch(() => false)) {
            return;
        }

        const downloadPath = Path.join(download_folder, getFileKey(image));
        let imageData;
        try {
            imageData = await got(refreshedURLs[i], { responseType: 'buffer' });
        } catch (error) {
            throw new Error(`Failed to download image ${image.name} at ${refreshedURLs[i]}, try reuploading the file directly to the thread.`);
        }
        await fs.writeFile(downloadPath, imageData.body);
        let simage = sharp(downloadPath);
        const stats = await simage.stats();
        if (!stats.isOpaque) {
            simage = simage.trim();
        }

        const s = await simage
            .resize({
                width: 800,
                height: 800,
                fit: 'inside',
                withoutEnlargement: true,
            })
            .toFormat('png')
            .toFile(processedPath);


        image.width = s.width;
        image.height = s.height;

        await fs.unlink(downloadPath); // Remove the original file after processing
    }));

    // Remove the download folder if it was created
    try {
        await fs.rmdir(download_folder);
    } catch (err) {

    }

    return images;

}


export async function processImageForDiscord(file_path: string, num_images: number, image_idx: number, isGalleryView: boolean): Promise<string> {
    const output_path = file_path + '.discord.png';
    let newWidth = 386 * 2;
    let newHeight = 258 * 2;
    let padding = 0;

    if (isGalleryView) {
        if (num_images === 1) { // Single image, use larger size
            padding = 60;
            newHeight = newHeight - padding;
        } else if (num_images === 2) { // Two images, width is half
            newWidth = Math.floor(newWidth / 2) - 15;
            padding = 60;
            newHeight = newHeight - padding;
        } else if (num_images === 3) { // Three images
            if (image_idx === 0) { // First image is large
                newWidth = 2 * Math.floor(newWidth / 3) - 15;
                newHeight = newHeight;
            } else { // Other two images are small
                newWidth = Math.floor(newWidth / 3) - 15;
                newHeight = Math.floor(newHeight / 2) - 15;
            }
            padding = 0;
        } else if (num_images === 4) { // Four images, all are small
            padding = 0;
        } else { // More than four images, all are tiny
            padding = 0;
        }
    } else { // not gallery view, use 1:1 aspect ratio
        newWidth = 800;
        newHeight = 800;
    }

    // Scale so that largest dimension is 800px
    if (newWidth > newHeight) {
        const scale = 800 / newWidth;
        newWidth = 800;
        newHeight = Math.floor(newHeight * scale);
        // also scale padding
        padding = Math.floor(padding * scale);
    } else {
        const scale = 800 / newHeight;
        newHeight = 800;
        newWidth = Math.floor(newWidth * scale);
        // also scale padding
        padding = Math.floor(padding * scale);
    }

    await sharp(file_path)
        .resize({
            width: newWidth,
            height: newHeight,
            fit: 'contain',
            // withoutEnlargement: true,
            background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .extend({
            bottom: padding,
            background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .toFormat('png')
        .toFile(output_path);

    return output_path;
}

export async function handleYoutubeLink(attachment: Attachment) {
    // https://noembed.com/embed?dataType=json&
    const url = attachment.url;
    const noEmbedAPI = 'https://noembed.com/embed?dataType=json&url=' + encodeURIComponent(url);
    try {
        const response = await got(noEmbedAPI, { responseType: 'json' });
        if (response.statusCode !== 200) {
            console.error(`Failed to fetch YouTube link details for ${url}: HTTP ${response.statusCode}`);
            return;
        }
        const data = response.body as any;
        attachment.youtube = {
            title: data.title || 'Unknown Title',
            author_name: data.author_name || 'Unknown Author',
            author_url: data.author_url || '',
            thumbnail_url: data.thumbnail_url || '',
            thumbnail_width: data.thumbnail_width || 0,
            thumbnail_height: data.thumbnail_height || 0,
            width: data.width || 0,
            height: data.height || 0,
        };
    } catch (error) {
        console.error(`Failed to fetch YouTube link details for ${url}:`, error);
    }
}

export async function processAttachments(attachments: Attachment[], attachments_folder: string, bot: Bot, remove_old: boolean = true): Promise<Attachment[]> {
    // Check if the folder exists, if not, create it
    if (attachments.length > 0) {
        if (!await fs.access(attachments_folder).then(() => true).catch(() => false)) {
            await fs.mkdir(attachments_folder, { recursive: true });
        }
    }

    // Remove attachments that are already processed but not in the current list
    if (remove_old) {
        const existingFiles = await fs.readdir(attachments_folder);
        await Promise.all(existingFiles.map(async file => {
            // check if the file is in the attachments list
            const fileKey = file.toLowerCase();
            if (!attachments.some(attachment => getFileKey(attachment) === fileKey)) {
                const filePath = Path.join(attachments_folder, file);
                try {
                    await fs.unlink(filePath);
                } catch (err) {
                    console.error(`Failed to remove file ${filePath}:`, err);
                }
            }
        }));
    }

    const attachmentURLs = attachments.map(a => a.url);
    const attachmentURLsRefreshed = await refreshAttachments(attachmentURLs, bot);

    // Process each attachment
    await Promise.all(attachments.map(async (attachment, index) => {
        const key = getFileKey(attachment);
        if (attachment.canDownload) {
            const attachmentPath = Path.join(attachments_folder, key);
            attachment.path = key;
            // If the attachment already exists, skip download
            if (!await fs.access(attachmentPath).then(() => true).catch(() => false)) {
                try {
                    const attachmentData = await got(attachmentURLsRefreshed[index], { responseType: 'buffer' });
                    await fs.writeFile(attachmentPath, attachmentData.body);
                } catch (error) {
                    throw new Error(`Failed to download attachment ${attachment.name} at ${attachmentURLsRefreshed[index]}, try reuploading the file directly to the thread.`);
                }
            }
        }
    }));

    // Analyze attachments
    await analyzeAttachments(attachments, attachments_folder);

    return attachments;
}

export async function analyzeAttachments(attachments: Attachment[], attachments_folder: string): Promise<Attachment[]> {
    const mcMeta = new MCMeta();
    await mcMeta.fetchVersionData();

    await Promise.all(attachments.map(async (attachment) => {
        const ext = attachment.name.split('.').pop();
        if (attachment.canDownload && attachment.path) {
            const attachmentPath = Path.join(attachments_folder, attachment.path);
            if (ext === 'litematic') {
                // Process litematic files
                await processLitematic(attachment, attachmentPath, mcMeta);
            } else if (ext === 'zip') {
                // Process zip files
                await processWDLs(attachment, attachmentPath);
            }
        } else if (attachment.contentType === 'youtube') {
            // Process YouTube links
            await handleYoutubeLink(attachment);
        }
    }));
    return attachments;
}

async function processLitematic(attachment: Attachment, attachmentPath: string, mcMeta: MCMeta): Promise<void> {
    try {
        const litematicFile = await fs.readFile(attachmentPath);
        const litematic = new Litematic(litematicFile as any)
        await litematic.read()

        const dataVersion = litematic.litematic?.nbtData.MinecraftDataVersion ?? 0;
        const version = mcMeta.getByDataVersion(dataVersion);
        const size = litematic.litematic?.blocks ?? { minx: 0, miny: 0, minz: 0, maxx: 0, maxy: 0, maxz: 0 };
        const sizeString = `${size.maxx - size.minx + 1}x${size.maxy - size.miny + 1}x${size.maxz - size.minz + 1}`
        attachment.litematic = {
            size: sizeString,
            version: version ? version.id : 'Unknown',
        }
    } catch (error) {
        console.error('Error processing litematic file:', error)
        attachment.litematic = {
            error: 'Error processing litematic file'
        }
    }
}



async function processWDLs(attachment: Attachment, attachmentPath: string): Promise<void> {
    try {
        const levelDat = await findFirstFileWithNameInZip(attachmentPath, 'level.dat');
        if (!levelDat) {
            return; // No level.dat found, nothing to process
        }

        const levelDatBuffer = levelDat;
        const parsedNbt = await nbt.parse(levelDatBuffer);
        const data = parsedNbt.parsed as any;
        if (data.type !== 'compound' || !data.value) {
            attachment.wdl = { error: 'Invalid Level.dat' };
            return;
        }

        const dataTag = data.value.Data;
        if (!dataTag || dataTag.type !== 'compound' || !dataTag.value) {
            attachment.wdl = { error: 'Invalid Level.dat' };
            return;
        }

        const versionTag = dataTag.value.Version;
        if (!versionTag || versionTag.type !== 'compound' || !versionTag.value) {
            attachment.wdl = { error: 'Invalid Level.dat' };
            return;
        }

        const versionName = versionTag.value.Name;
        if (!versionName || versionName.type !== 'string' || !versionName.value) {
            attachment.wdl = { error: 'Invalid Level.dat' };
            return;
        }

        attachment.wdl = { version: versionName.value };
    } catch (error) {
        console.error('Error processing WDL file:', error);
    }
}

async function iterateAllMessages(channel: TextBasedChannel, iterator: (message: Message) => Promise<boolean>) {
    let messages = await channel.messages.fetch({ limit: 100 });
    while (messages.size > 0) {
        for (const msg of messages.values()) {
            // If the iterator returns false, stop iterating
            if (!await iterator(msg)) {
                return;
            }
        }
        messages = await channel.messages.fetch({ limit: 100, before: messages.last()?.id });
    }
}
export function getAttachmentsFromText(text: string, attachments: Attachment[] = [], suffix = ""): Attachment[] {
    // Find all URLs in the message
    const urls = text.match(/https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g)
    if (urls) {
        urls.forEach(url => {
            // Check if mediafire
            // https://www.mediafire.com/file/idjbw9lc1kt4obj/1_17_Crafter-r2.zip/file
            // https://www.mediafire.com/folder/5ajiire4a6cs5/Scorpio+MIS
            if (url.startsWith('https://www.mediafire.com/file/') || url.startsWith('https://www.mediafire.com/folder/')) {
                const id = url.split('/')[4]
                const name = url.split('/')[5]
                // check if duplicate
                if (attachments.some(attachment => attachment.id === id)) {
                    return;
                }
                attachments.push({
                    id: id,
                    name: name,
                    contentType: 'mediafire',
                    url: url,
                    description: `[MediaFire]${suffix}`,
                    canDownload: false // MediaFire links cannot be downloaded directly
                })
            } else if (url.startsWith('https://youtu.be/') || url.startsWith('https://www.youtube.com/watch')) {
                // YouTube links
                const videoId = new URL(url).searchParams.get('v') || url.split('/').pop();
                if (!videoId) return;
                if (attachments.some(attachment => attachment.id === videoId)) {
                    return;
                }

                const urlCleaned = new URL(url);
                // remove the si parameter if exists for anti-tracking
                urlCleaned.searchParams.delete('si');
                
                attachments.push({
                    id: videoId,
                    name: `YouTube Video ${videoId}`,
                    contentType: 'youtube',
                    url: urlCleaned.toString(),
                    description: `[YouTube]${suffix}`,
                    canDownload: false // YouTube links cannot be downloaded directly
                })
            } else if (url.startsWith('https://cdn.discordapp.com/attachments/')) {
                // https://cdn.discordapp.com/attachments/749137321710059542/912059917106548746/Unbreakable_8gt_reset_6gt_box_replacement.litematic?ex=6832c4bd&is=6831733d&hm=1e5ff51ca94199d70f26ad2611715c86afbb095e3da120416e55352ccf43f7a4&
                const id = url.split('/')[5]
                const name = url.split('/')[6].split('?')[0]
                if (attachments.some(attachment => attachment.id === id)) {
                    return;
                }
                attachments.push({
                    id: id,
                    name: name,
                    contentType: 'discord',
                    url: url,
                    description: `[DiscordCDN]${suffix}`,
                    canDownload: true // Discord CDN links can be downloaded directly
                })
            } else if (url.startsWith('https://bilibili.com/') || url.startsWith('https://www.bilibili.com/')) {
                // Bilibili links
                const urlObj = new URL(url);
                const videoId = urlObj.pathname.split('/')[2] || urlObj.searchParams.get('bvid');
                if (!videoId) return;
                if (attachments.some(attachment => attachment.id === videoId)) {
                    return;
                }
                attachments.push({
                    id: videoId,
                    name: `Bilibili Video ${videoId}`,
                    contentType: 'bilibili',
                    url: url,
                    description: `[Bilibili]${suffix}`,
                    canDownload: false // Bilibili links cannot be downloaded directly
                })
            }
        })
    }
    return attachments;
}
export function getAttachmentsFromMessage(message: Message, attachments: Attachment[] = []): Attachment[] {
    if (message.content.length > 0) {
        // Get attachments from the message text
        getAttachmentsFromText(message.content, attachments, ` Sent by ${message.author.username} at ${message.createdAt.toLocaleString()}`);
    }
    if (message.attachments.size > 0) {
        message.attachments.forEach(attachment => {
            const index = attachments.findIndex(attachment2 => attachment2.id === attachment.id);

            if (index !== -1) {
                // remove duplicate
                attachments.splice(index, 1);
                return;
            }
            attachments.push({
                id: attachment.id,
                name: attachment.name,
                contentType: attachment.contentType || 'unknown',
                url: attachment.url,
                description: `Sent by ${message.author.username} at ${message.createdAt.toLocaleString()}`,
                canDownload: true, // Discord attachments can be downloaded directly
            });
        })
    }
    return attachments;
}

export async function getAllAttachments(channel: TextThreadChannel): Promise<Attachment[]> {
    let attachments: Attachment[] = [];

    await iterateAllMessages(channel, async (message: Message) => {
        if (message.author.bot && message.author.id !== '1392335374722007261') {
            return true;
        }
        // Get attachments from the message
        getAttachmentsFromMessage(message, attachments);

        return true;
    });
    return attachments;
}


export async function refreshAttachments(
    attachmentURLs: string[],
    bot: Bot
): Promise<string[]> {
    if (!attachmentURLs || attachmentURLs.length === 0) {
        return [];
    }

    const attachmentObjects: { url: string }[] = attachmentURLs.map(url => ({ url }));
    const expiringAttachments = attachmentObjects.filter(obj => {
        const url = obj.url;
        if (!url) return false; // No URL provided

        // Check if discord cdn
        if (!url.startsWith('https://cdn.discordapp.com/attachments/')) {
            return false; // Not a Discord CDN URL
        }
        // get the `ex` parameter from the URL
        const urlObj = new URL(url);
        const exParam = urlObj.searchParams.get('ex');
        if (!exParam) return true; // No expiration parameter
        if (parseInt(exParam, 16) * 1000 > Date.now()) { // If the expiration is in the future, keep it
            return !(urlObj.searchParams.get("is") && urlObj.searchParams.get("hm"))
        }
        // check other parameters
        return true;
    });

    if (expiringAttachments.length > 0) {
        try {
            const result = await bot.client.rest.post('/attachments/refresh-urls', {
                body: {
                    attachment_urls: expiringAttachments.map(a => a.url)
                },
            }) as any;
            if (!result || !result.refreshed_urls || !Array.isArray(result.refreshed_urls)) {
                throw new Error('Invalid response from attachment refresh API');
            }

            result.refreshed_urls.forEach((data: { original: string, refreshed: string }) => {
                if (!data.original || !data.refreshed) {
                    console.warn(`Invalid data received for attachment refresh: ${JSON.stringify(data)}`);
                    return;
                }
                const index = attachmentObjects.findIndex(obj => obj.url === data.original);
                if (index !== -1) {
                    attachmentObjects[index].url = data.refreshed;
                } else {
                    console.warn(`Original URL ${data.original} not found in attachment objects.`);
                }
            });
        } catch (error: any) {
            console.error(`Failed to refresh attachment URLs: ${error.message}`);
            throw new Error(`Failed to refresh attachment URLs, try reuploading the files directly to the thread. Error: ${error.message}`);
        }
    }
    return attachmentObjects.map(obj => obj.url);
}


export function getFileKey(file: Attachment | Image, new_ext: string = '') {
    const name = `${file.id}-${escapeString(file.name)}`.toLowerCase();
    // First, get file extension if it exists
    const split = name.split('.')
    let ext = split.length > 1 ? split.pop() : '';
    if (new_ext) {
        ext = new_ext.toLowerCase();
    }
    const prefix = split.join('.');
    // Then, escape the string
    const escapedPrefix = escapeString(prefix)
    const escapedExt = ext ? `.${escapeString(ext)}` : ''
    return `${escapedPrefix}${escapedExt}`;
}

async function findFirstFileWithNameInZip(zipPath: string, fileName: string): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
        // 100 MB
        const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
        yauzl.open(zipPath, {
            lazyEntries: true,
            validateEntrySizes: true
        }, (err, zipfile) => {
            if (err) {
                return reject(err);
            }

            zipfile.readEntry();
            zipfile.on('entry', (entry) => {
                const normalized = Path.posix.normalize(entry.fileName); // yauzl always gives / separators
                const isDir = normalized.endsWith("/");
                if (normalized.startsWith("../") || Path.isAbsolute(normalized)) {
                    zipfile.close();                                               // hard-fail the whole archive
                    return reject(new Error(`Path traversal detected: ${entry.fileName}`));
                }

                if (isDir) {
                    zipfile.readEntry();                                           // nothing to extract
                    return;
                }

                // Size checks
                if (entry.uncompressedSize > MAX_FILE_SIZE) {
                    zipfile.close();
                    return reject(
                        new Error(`Entry ${entry.fileName} is ${entry.uncompressedSize} bytes (> limit)`),
                    );
                }

                if (Path.posix.basename(normalized) !== fileName) {
                    zipfile.readEntry();
                    return;
                }

                zipfile.openReadStream(entry, (err, readStream) => {
                    if (err) {
                        zipfile.close();
                        return reject(err);
                    }

                    const chunks: Buffer[] = [];
                    readStream.on('data', (chunk) => {
                        chunks.push(chunk);
                    });

                    readStream.on('end', () => {
                        const fileBuffer = Buffer.concat(chunks);
                        zipfile.close();
                        resolve(fileBuffer); // Return the file buffer
                    });

                    readStream.on('error', (error) => {
                        zipfile.close();
                        reject(error);
                    });
                });
            });

            zipfile.on('end', () => {
                zipfile.close();
                resolve(null); // No file found
            });

            zipfile.on('error', (error) => {
                zipfile.close();
                reject(error);
            });
        });
    });
}