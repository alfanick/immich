import { All, Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import http from 'node:http';
import { Endpoint, HistoryBuilder } from 'src/decorators';
import { AuthDto } from 'src/dtos/auth.dto';
import {
  MiniFilmApplyJobCreateDto,
  MiniFilmApplyJobResponseDto,
  MiniFilmImportResponseDto,
  MiniFilmProfileTreeDto,
  MiniFilmReviewSessionCreateDto,
  MiniFilmReviewSessionImportDto,
  MiniFilmReviewSessionResponseDto,
} from 'src/dtos/mini-film.dto';
import { ApiTag } from 'src/enum';
import { Auth, Authenticated } from 'src/middleware/auth.guard';
import { MiniFilmService } from 'src/services/mini-film.service';
import { UUIDParamDto } from 'src/validation';

@ApiTags(ApiTag.MiniFilm)
@Controller('mini-film')
export class MiniFilmController {
  constructor(private service: MiniFilmService) {}

  @Get('profiles')
  @Authenticated()
  @Endpoint({
    summary: 'Get mini-film profile tree',
    description: 'Retrieve the mini-film profile trie built from configured emulation XMP files.',
    history: new HistoryBuilder().added('v1'),
  })
  getProfileTree(@Auth() auth: AuthDto, @Query('includeAll') includeAll?: string): Promise<MiniFilmProfileTreeDto> {
    return this.service.getProfileTree(auth, includeAll === 'true');
  }

  @Post('review-sessions')
  @Authenticated()
  @Endpoint({
    summary: 'Start mini-film review session',
    description: 'Create a symlink input folder and start a mini-film daemon review session.',
    history: new HistoryBuilder().added('v1'),
  })
  createReviewSession(
    @Auth() auth: AuthDto,
    @Body() dto: MiniFilmReviewSessionCreateDto,
  ): Promise<MiniFilmReviewSessionResponseDto> {
    return this.service.createReviewSession(auth, dto);
  }

  @Get('review-sessions')
  @Authenticated()
  @Endpoint({
    summary: 'List mini-film review sessions',
    description: 'List mini-film review sessions visible to the authenticated user.',
    history: new HistoryBuilder().added('v1'),
  })
  listReviewSessions(@Auth() auth: AuthDto): Promise<MiniFilmReviewSessionResponseDto[]> {
    return this.service.listReviewSessions(auth);
  }

  @Get('review-sessions/:id')
  @Authenticated()
  @Endpoint({
    summary: 'Get mini-film review session',
    description: 'Retrieve a mini-film review session by ID.',
    history: new HistoryBuilder().added('v1'),
  })
  getReviewSession(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<MiniFilmReviewSessionResponseDto> {
    return this.service.getReviewSession(auth, id);
  }

  @Post('review-sessions/:id/import')
  @Authenticated()
  @Endpoint({
    summary: 'Import mini-film review outputs',
    description:
      'Publish a mini-film review session, import generated images into Immich, create an album, then stop the daemon.',
    history: new HistoryBuilder().added('v1'),
  })
  importReviewSession(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: MiniFilmReviewSessionImportDto,
  ): Promise<MiniFilmImportResponseDto> {
    return this.service.importReviewSession(auth, id, dto);
  }

  @Delete('review-sessions/:id')
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete mini-film review session',
    description: 'Stop and remove a mini-film review session.',
    history: new HistoryBuilder().added('v1'),
  })
  deleteReviewSession(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.deleteReviewSession(auth, id);
  }

  @Post('apply-jobs')
  @Authenticated()
  @Endpoint({
    summary: 'Start mini-film apply job',
    description: 'Run mini-film apply for selected RAW assets and import generated images into a new album.',
    history: new HistoryBuilder().added('v1'),
  })
  createApplyJob(@Auth() auth: AuthDto, @Body() dto: MiniFilmApplyJobCreateDto): Promise<MiniFilmApplyJobResponseDto> {
    return this.service.createApplyJob(auth, dto);
  }

  @Get('apply-jobs')
  @Authenticated()
  @Endpoint({
    summary: 'List mini-film apply jobs',
    description: 'List mini-film apply jobs visible to the authenticated user.',
    history: new HistoryBuilder().added('v1'),
  })
  listApplyJobs(@Auth() auth: AuthDto): Promise<MiniFilmApplyJobResponseDto[]> {
    return this.service.listApplyJobs(auth);
  }

  @Get('apply-jobs/:id')
  @Authenticated()
  @Endpoint({
    summary: 'Get mini-film apply job',
    description: 'Retrieve a mini-film apply job by ID.',
    history: new HistoryBuilder().added('v1'),
  })
  getApplyJob(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<MiniFilmApplyJobResponseDto> {
    return this.service.getApplyJob(auth, id);
  }

  @All('review-sessions/:id/review')
  @Authenticated()
  proxyReviewRoot(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Req() req: Request, @Res() res: Response) {
    return this.proxyReview(auth, id, req, res);
  }

  @All('review-sessions/:id/review/*path')
  @Authenticated()
  proxyReviewPath(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Req() req: Request, @Res() res: Response) {
    return this.proxyReview(auth, id, req, res);
  }

  private async proxyReview(auth: AuthDto, id: string, req: Request, res: Response) {
    const { port } = await this.service.getReviewProxyTarget(auth, id);
    const targetPath = this.getProxyPath(req.originalUrl, id);
    const body = this.getProxyBody(req);
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers['content-length'];
    if (body) {
      headers['content-length'] = String(body.length);
      headers['content-type'] = headers['content-type'] || 'application/json';
    }

    const proxyRequest = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: targetPath,
        method: req.method,
        headers,
      },
      (proxyResponse) => {
        res.status(proxyResponse.statusCode ?? 502);
        for (const [key, value] of Object.entries(proxyResponse.headers)) {
          if (value !== undefined) {
            res.setHeader(key, value);
          }
        }
        proxyResponse.pipe(res);
      },
    );

    proxyRequest.on('error', (error) => {
      if (res.headersSent) {
        res.end();
      } else {
        res.status(502).json({ message: `mini-film review proxy failed: ${error.message}` });
      }
    });

    if (body) {
      proxyRequest.end(body);
    } else {
      req.pipe(proxyRequest);
    }
  }

  private getProxyPath(originalUrl: string, id: string) {
    const marker = `/mini-film/review-sessions/${id}/review`;
    const index = originalUrl.indexOf(marker);
    const target = index === -1 ? '/' : originalUrl.slice(index + marker.length) || '/';
    return target.startsWith('?') ? `/${target}` : target;
  }

  private getProxyBody(req: Request): Buffer | undefined {
    if (req.method === 'GET' || req.method === 'HEAD') {
      return;
    }
    if (Buffer.isBuffer(req.body)) {
      return req.body;
    }
    if (typeof req.body === 'string') {
      return Buffer.from(req.body);
    }
    if (req.body && Object.keys(req.body).length > 0) {
      return Buffer.from(JSON.stringify(req.body));
    }
  }
}
