import { PickType } from '@nestjs/swagger';
import { SearchDocumentsQueryDto } from '../documents/dto/search-documents-query.dto';

export class HybridSearchQuery extends PickType(SearchDocumentsQueryDto, ['q', 'limit'] as const) {}
