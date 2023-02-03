import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';
import { ChatgptPoolService } from './chatgpt-pool/chatgpt-pool.service';
import { Cron } from '@nestjs/schedule';
@Injectable()
export class ChatgptService {
  logger = new Logger('ChatgptService');
  constructor(
    private prismaService: PrismaService,
    private chatgptPoolService: ChatgptPoolService
  ) {
    (async () => {
      await this.stopAllChatGPTInstances();
      await this.startAllDownAccount();
    })();
  }
  async createChatGPTAccount(account: {
    email: string;
    password: string;
    isGoogleLogin?: boolean;
    isMicrosoftLogin?: boolean;
  }) {
    return this.prismaService.chatGPTAccount.create({
      data: account,
    });
  }
  async deleteChatGPTAccount(email: string) {
    this.chatgptPoolService.deleteChatGPTInstanceByEmail(email);
    return this.prismaService.chatGPTAccount.delete({
      where: { email },
    });
  }
  async updateChatGPTAccount(
    email: string,
    account: {
      email: string;
      password: string;
      isGoogleLogin?: boolean;
      isMicrosoftLogin?: boolean;
      // User can only stop the chatgpt account
      status?: 'Stopped';
    }
  ) {
    this.chatgptPoolService.deleteChatGPTInstanceByEmail(email);
    const chatgptAccount = await this.prismaService.chatGPTAccount.update({
      where: { email },
      data: { ...account, status: 'Down' },
    });
    if (account.status === 'Stopped') {
      return this.prismaService.chatGPTAccount.update({
        where: { email },
        data: { status: 'Stopped' },
      });
    }
    // TODO: add queue support
    this.chatgptPoolService.initChatGPTInstance(account);
    return chatgptAccount;
  }
  async getChatGPTAccount(email: string) {
    const chatGPTAccount = await this.prismaService.chatGPTAccount.findUnique({
      where: { email },
      select: {
        email: true,
        isGoogleLogin: true,
        isMicrosoftLogin: true,
        status: true,
      },
    });
    return chatGPTAccount;
  }
  async getAllChatGPT() {
    return this.prismaService.chatGPTAccount.findMany({
      select: {
        email: true,
        isGoogleLogin: true,
        isMicrosoftLogin: true,
        status: true,
      },
    });
  }
  async getCurrentActiveChatGPT() {
    const account = await this.prismaService.chatGPTAccount.findMany({
      where: { status: 'Running' },
      select: {
        email: true,
      },
    });
    const email = account[Math.floor(Math.random() * account.length)].email;
    return email;
  }
  // Send Chatgpt Message via ChatgptPoolService
  async sendChatGPTMessage(
    message: string,
    opts?: {
      sessionId?: string;
      tenantId: string;
    }
  ) {
    let email: string;
    const { sessionId, tenantId } = opts;
    const conversation = await this.prismaService.chatGPTConversation.findFirst(
      {
        where: { sessionId, tenantId },
      }
    );
    if (!conversation) {
      email = await this.getCurrentActiveChatGPT();
    } else {
      email = conversation.email;
    }
    // Send Message
    this.logger.debug(`Send message to ${email}: ${message}`);
    try {
      const messageResult = await this.chatgptPoolService.sendMessage(message, {
        email: email,
        conversationId: conversation?.conversationId,
        parentMessageId: conversation?.messageId,
      });
      if (!messageResult) {
        this.logger.error(`Send message to ${email} failed`);
        return {
          conversationId: null,
          messageId: null,
          message: null,
        };
      }
      // Save conversation info
      await this.prismaService.chatGPTConversation.upsert({
        where: { tenantId_sessionId: { sessionId, tenantId } },
        create: {
          sessionId,
          email,
          conversationId: messageResult.conversationId,
          messageId: messageResult.messageId,
          tenantId,
        },
        update: {
          email,
          conversationId: messageResult.conversationId,
          messageId: messageResult.messageId,
        },
      });
      return messageResult;
    } catch (e) {
      this.logger.error(`Send message to ${email} failed: ${e}`);
      // Update Email status
      this.prismaService.chatGPTAccount.update({
        where: { email },
        data: { status: 'Error' },
      });
    }
  }
  async sendChatGPTMessageOnetime(message: string) {
    const email = await this.getCurrentActiveChatGPT();
    this.logger.debug(`Send message to ${email}: ${message}`);
    try {
      const messageResult = await this.chatgptPoolService.sendMessage(message, {
        email: email,
      });
      if (!messageResult) {
        this.logger.error(`Send message to ${email} failed`);
        return {
          conversationId: null,
          messageId: null,
          message: null,
        };
      }
      return messageResult;
    } catch (e) {
      this.logger.error(`Send message to ${email} failed: ${e}`);
      // Update Email status
      this.prismaService.chatGPTAccount.update({
        where: { email },
        data: { status: 'Error' },
      });
    }
  }
  async startChatgptInstance(email: string) {
    // As Lock
    const account = await this.prismaService.chatGPTAccount.findFirst({
      where: { AND: [{ email }, { status: 'Down' }] },
    });
    if (!account) {
      this.logger.error(`Account ${email} is not down`);
      return;
    }
    this.logger.debug(`Start account ${account.email}`);
    await this.prismaService.chatGPTAccount.update({
      where: { email: account.email },
      data: { status: 'Starting' },
    });
    try {
      await this.chatgptPoolService.initChatGPTInstance(account);
      await this.prismaService.chatGPTAccount.update({
        where: { email: account.email },
        data: { status: 'Running' },
      });
    } catch (err) {
      this.logger.error(`Error starting account ${account.email}: ${err}`);
      await this.prismaService.chatGPTAccount.update({
        where: { email: account.email },
        data: { status: 'Error' },
      });
    }
  }
  async stopAllChatGPTInstances() {
    this.logger.debug('Stop all chatgpt instances');
    const accounts = await this.prismaService.chatGPTAccount.findMany({
      where: {
        OR: [
          { status: 'Running' },
          {
            status: 'Starting',
          },
          {
            status: 'Error',
          },
        ],
      },
      select: {
        email: true,
      },
    });
    console.log(`Found ${accounts.length} running accounts`);
    for (const account of accounts) {
      this.chatgptPoolService.deleteChatGPTInstanceByEmail(account.email);
      await this.prismaService.chatGPTAccount.update({
        where: { email: account.email },
        data: { status: 'Down' },
      });
    }
    this.logger.debug(`Found ${accounts.length} running accounts`);
  }
  async resetSession(sessionId: string, tenantId: string) {
    this.logger.debug(`Reset conversation ${sessionId}`);
    const conversation = await this.prismaService.chatGPTConversation.delete({
      where: {
        tenantId_sessionId: { sessionId, tenantId },
      },
    });
    if (!conversation) {
      this.logger.error(`Conversation ${sessionId} not found`);
      return {};
    } else {
      this.logger.debug(`Conversation ${sessionId} deleted`);
      return conversation;
    }
  }
  @Cron('1 * * * * *')
  async startAllDownAccount() {
    this.logger.debug('Start all down account');
    const accounts = await this.prismaService.chatGPTAccount.findMany({
      where: { status: 'Down' },
      select: {
        email: true,
      },
      take: 1,
    });
    this.logger.debug(`Found ${accounts.length} down accounts`);
    for (const account of accounts) {
      await this.startChatgptInstance(account.email);
    }
  }
  // Update account status to Running
  @Cron('1 * * * * *')
  async heartbeat() {
    const emails = Array.from(this.chatgptPoolService.accounts);
    // update db account status
    this.logger.debug(`Update account status: ${emails}`);
    this.prismaService.chatGPTAccount.updateMany({
      where: { email: { in: emails } },
      data: { status: 'Starting' },
    });
    this.prismaService.chatGPTAccount.updateMany({
      where: { email: { notIn: emails } },
      data: { status: 'Running' },
    });
  }
}
